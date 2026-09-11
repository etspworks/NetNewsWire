/**
 * ErrorLogEntry — port of Modules/ErrorLog/Sources/ErrorLog/ErrorLogEntry.swift
 *
 * One row of the error log the Settings > Error Log screen lists. The column names are the
 * source's DatabaseKey values and match the CREATE TABLE in ErrorLogDatabase.swift.
 */

export interface ErrorLogEntry {
  id: number;
  date: Date;
  sourceName: string;
  /** 0-99 reserved for AccountType raw values; 100 and up for other components. */
  sourceID: number;
  operation: string;
  fileName: string;
  functionName: string;
  lineNumber: number;
  errorMessage: string;
}

export class ErrorLogEntryKeys {
  static readonly id: string = 'id';
  static readonly date: string = 'date';
  static readonly sourceName: string = 'sourceName';
  static readonly sourceID: string = 'sourceID';
  static readonly operation: string = 'operation';
  static readonly fileName: string = 'fileName';
  static readonly functionName: string = 'functionName';
  static readonly lineNumber: string = 'lineNumber';
  static readonly errorMessage: string = 'errorMessage';
}
