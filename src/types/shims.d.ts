/**
 * Ambient module shims so the standalone Jest/ts-jest toolchain can type-check
 * the data layer without installing the full React Native dependency tree.
 * The real type definitions ship with the corresponding npm packages.
 */

declare module 'react-native-sqlite-storage' {
  export interface ResultSet {
    rowsAffected: number;
    insertId?: number;
    rows: {
      length: number;
      item(index: number): any;
    };
  }
  export interface Transaction {
    executeSql(sql: string, params?: any[]): void;
  }
  export interface SQLiteDatabase {
    executeSql(sql: string, params?: any[]): Promise<[ResultSet]>;
    transaction(scope: (tx: Transaction) => void): Promise<Transaction>;
    close(): Promise<void>;
  }
  export function openDatabase(params: {
    name: string;
    location?: string;
  }): Promise<SQLiteDatabase>;
  export function enablePromise(enable: boolean): void;
  export function DEBUG(enable: boolean): void;
  const SQLite: {
    openDatabase: typeof openDatabase;
    enablePromise: typeof enablePromise;
    DEBUG: typeof DEBUG;
  };
  export default SQLite;
}

declare module 'react-native-encrypted-storage' {
  const EncryptedStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export default EncryptedStorage;
}
