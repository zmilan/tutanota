//@flow
import {DbError} from "../../common/error/DbError"
import {LazyLoaded} from "../../common/utils/LazyLoaded"


export type ObjectStoreName = string
export const SearchIndexOS: ObjectStoreName = "SearchIndex"
export const SearchIndexMetaDataOS: ObjectStoreName = "SearchIndexMeta"
export const ElementDataOS: ObjectStoreName = "ElementData"
export const MetaDataOS: ObjectStoreName = "MetaData"
export const GroupDataOS: ObjectStoreName = "GroupMetaData"
export const SearchTermSuggestionsOS: ObjectStoreName = "SearchTermSuggestions"

export const osName = (objectStoreName: ObjectStoreName): string => objectStoreName

export type IndexName = string
export const SearchIndexWordsIndex: IndexName = "SearchIndexWords"
export const indexName = (indexName: IndexName): string => indexName

const DB_VERSION = 3


export interface DbTransaction {
	getAll(objectStore: ObjectStoreName): Promise<{key: string | number, value: any}[]>;

	get<T>(objectStore: ObjectStoreName, key: (string | number), indexName?: IndexName): Promise<?T>;

	getAsList<T>(objectStore: ObjectStoreName, key: string | number, indexName?: IndexName): Promise<T[]>;

	put(objectStore: ObjectStoreName, key: ?(string | number), value: any): Promise<any>;


	delete(objectStore: ObjectStoreName, key: string | number): Promise<void>;

	abort(): void;

	wait(): Promise<void>;

	aborted: boolean
}


function extractErrorProperties(e: any) {
	const requestErrorEntries = {}
	for (let key in e) {
		requestErrorEntries[key] = e[key]
	}
	return JSON.stringify(requestErrorEntries)
}

export class DbFacade {
	_id: string;
	_db: LazyLoaded<IDBDatabase>;
	_activeTransactions: number;

	constructor(supported: boolean, onupgrade?: () => void) {
		this._activeTransactions = 0
		this._db = new LazyLoaded(() => {
			// If indexedDB is disabled in Firefox, the browser crashes when accessing indexedDB in worker process
			// ask the main thread if indexedDB is supported.
			if (!supported) {
				return Promise.reject(new DbError("indexedDB not supported"))
			} else {
				return new Promise.fromCallback(callback => {
					let DBOpenRequest
					try {

						DBOpenRequest = indexedDB.open(this._id, DB_VERSION)
						DBOpenRequest.onerror = (event) => {
							// Copy all the keys from the error, including inheritent ones so we can get some info

							const requestErrorEntries = extractErrorProperties(DBOpenRequest.error)
							const eventProperties = extractErrorProperties(event)
							callback(new DbError("DbFacade.open.onerror: " + this._id +
								"\nrequest.error: " + requestErrorEntries +
								"\nevent: " + eventProperties +
								"\nevent.target.error" + (event.target ? event.target.error : "[none]"), DBOpenRequest.error))
						}

						DBOpenRequest.onupgradeneeded = (event) => {
							//console.log("upgrade db", event)
							let db = event.target.result
							if (event.oldVersion !== DB_VERSION && event.oldVersion !== 0) {
								if (onupgrade) onupgrade()

								this._deleteObjectStores(db,
									SearchIndexOS,
									ElementDataOS,
									MetaDataOS,
									GroupDataOS,
									SearchTermSuggestionsOS,
									SearchIndexMetaDataOS
								)
							}

							try {
								db.createObjectStore(SearchIndexOS, {autoIncrement: true})
								const metaOS = db.createObjectStore(SearchIndexMetaDataOS, {autoIncrement: true, keyPath: "id"})
								db.createObjectStore(ElementDataOS)
								db.createObjectStore(MetaDataOS)
								db.createObjectStore(GroupDataOS)
								db.createObjectStore(SearchTermSuggestionsOS)
								metaOS.createIndex(SearchIndexWordsIndex, "word", {unique: true})
							} catch (e) {
								callback(new DbError("could not create object store searchindex", e))
							}
						}

						DBOpenRequest.onsuccess = (event) => {
							//console.log("opened db", event)
							DBOpenRequest.result.onabort = (event) => console.log("db aborted", event)
							DBOpenRequest.result.onclose = (event) => {
								console.log("db closed", event)
								this._db.reset()
							}
							DBOpenRequest.result.onerror = (event) => console.log("db error", event)
							callback(null, DBOpenRequest.result)
						}
					} catch (e) {
						callback(new DbError(`exception when accessing indexeddb ${this._id}`, e))
					}
				})
			}
		})
	}

	_deleteObjectStores(db: IDBDatabase, ...oss: string[]) {
		for (let os of oss) {
			try {
				db.deleteObjectStore(os)
			} catch (e) {
				console.log("Error while deleting old os", os, "ignoring", e)
			}
		}
	}

	open(id: string): Promise<void> {
		this._id = id
		return this._db.getAsync().return()
	}

	/**
	 * Deletes the database if it has been opened.
	 */
	deleteDatabase(): Promise<void> {
		if (this._db.isLoaded()) {
			if (this._activeTransactions > 0) {
				return Promise.delay(150).then(() => this.deleteDatabase())
			} else {
				this._db.getLoaded().close()
				return Promise.fromCallback(cb => {
					let deleteRequest = indexedDB.deleteDatabase(this._db.getLoaded().name)
					deleteRequest.onerror = (event) => {
						cb(new DbError(`could not delete database ${this._db.getLoaded().name}`, event))
					}
					deleteRequest.onsuccess = (event) => {
						this._db.reset()
						cb()
					}
				})
			}
		} else {
			return Promise.resolve()
		}
	}

	/**
	 * @pre open() must have been called before, but the promise does not need to have returned.
	 */
	createTransaction(readOnly: boolean, objectStores: ObjectStoreName[]): Promise<DbTransaction> {
		return this._db.getAsync().then(db => {
			try {
				const transaction = new IndexedDbTransaction(db.transaction((objectStores: string[]), readOnly ? "readonly" : "readwrite"))
				this._activeTransactions++
				transaction.wait().finally(() => {
					this._activeTransactions--
				})
				return transaction
			} catch (e) {
				throw new DbError("could not create transaction", e)
			}
		})
	}

}

type DbRequest = {
	action: Function;
	objectStore: string;
}

/**
 * A transaction is usually committed after all requests placed against the transaction have been executed and their
 * returned results handled, and no new requests have been placed against the transaction.
 * @see https://w3c.github.io/IndexedDB/#ref-for-transaction-finish
 */
export class IndexedDbTransaction implements DbTransaction {
	_transaction: IDBTransaction;
	_promise: Promise<void>;
	aborted: boolean;

	constructor(transaction: IDBTransaction) {
		this._transaction = transaction
		this._promise = Promise.fromCallback((callback) => {
			transaction.onerror = (event) => {
				const errorEntries = extractErrorProperties(event)
				callback(new DbError("IndexedDbTransaction.transaction.onerror, \nevent:" + errorEntries +
					"\ntransaction.error" + (transaction.error ? transaction.error.message : '') +
					"\nevent.target.error: " + (event.target.error ? event.target.error.message : '')
					, transaction.error))
			}
			transaction.oncomplete = (event) => {
				callback()
			}
			transaction.onabort = (event) => {
				callback()
			}
		})
	}

	getAll(objectStore: ObjectStoreName): Promise<{key: string | number, value: any}[]> {
		return Promise.fromCallback((callback) => {
			try {
				let keys = []
				let request = (this._transaction.objectStore(objectStore): any).openCursor()
				request.onerror = (event) => {
					callback(new DbError("IndexedDbTransaction.getAll().onerror\nos: " + objectStore + "\nevent: " + extractErrorProperties(event) +
						"\nrequest.error:" + request.error && request.error.message, request.error))
				}
				request.onsuccess = (event) => {
					let cursor = request.result
					if (cursor) {
						keys.push({key: cursor.key, value: cursor.value})
						cursor.continue() // onsuccess is called again
					} else {
						callback(null, keys) // cursor has reached the end
					}
				}
			} catch (e) {
				callback(new DbError("IndexedDbTransaction.getAll().catch\nos: " + objectStore + "\nmessage: " + e.message, e))
			}
		})
	}

	get<T>(objectStore: ObjectStoreName, key: (string | number), indexName?: IndexName): Promise<?T> {
		return Promise.fromCallback((callback) => {
			try {
				const os = this._transaction.objectStore(objectStore)
				let request
				if (indexName) {
					request = os.index(indexName).get(key)
				} else {
					request = os.get(key)
				}
				request.onerror = (event) => {
					callback(new DbError("IndexedDbTransaction.get().onerror\nos: " + objectStore + "\nevent: " + extractErrorProperties(event) +
						"\nrequest.error:" + (request.error ? request.error.message : "[none]"), request.error))
				}
				request.onsuccess = (event) => {
					callback(null, event.target.result)
				}
			} catch (e) {
				callback(new DbError("IndexedDbTransaction.get().catch\nos: " + objectStore + "\nmessage: " + e.message, e))
			}
		})
	}

	getAsList<T>(objectStore: ObjectStoreName, key: string | number, indexName?: IndexName): Promise<T[]> {
		return this.get(objectStore, key, indexName)
		           .then(result => result || [])
	}

	put(objectStore: ObjectStoreName, key: ?(string | number), value: any): Promise<any> {
		return Promise.fromCallback((callback) => {
			try {
				let request = key
					? this._transaction.objectStore(objectStore).put(value, key)
					: this._transaction.objectStore(objectStore).put(value)
				request.onerror = (event) => {
					const errorProperties = extractErrorProperties(event)
					callback(new DbError("IndexedDbTransaction.put().onerror\nos: " + objectStore + "\nevent: " + extractErrorProperties(event) +
						"\nrequest.error:" + (request.error ? request.error.message : "[none]") +
						"\nkey: " + String(key) +
						"\nvalue: " + JSON.stringify(value), request.error))
				}
				request.onsuccess = (event) => {
					callback(null, event.target.result)
				}
			} catch (e) {
				callback(new DbError("IndexedDbTransaction.put().catch\nos: " + objectStore + "\nmessage: " + e.message +
					"\nkey: " + key +
					"\nvalue: " + value, e))
			}
		})
	}


	delete(objectStore: ObjectStoreName, key: string | number): Promise<void> {
		return Promise.fromCallback((callback) => {
			try {
				let request = this._transaction.objectStore(objectStore).delete(key)
				request.onerror = (event) => {
					callback(new DbError("IndexedDbTransaction.delete().onerror\nos: " + objectStore + "\nevent: " + extractErrorProperties(event) +
						"\nrequest.error:" + (request.error ? request.error.message : "[none]"), request.error))
				}
				request.onsuccess = (event) => {
					callback()
				}
			} catch (e) {
				callback(new DbError("IndexedDbTransaction.delete().catch\nos: " + objectStore + "\nmessage: " + e.message, e))
			}
		})
	}

	abort() {
		this.aborted = true
		this._transaction.abort()
	}

	wait(): Promise<void> {
		return this._promise
	}
}
