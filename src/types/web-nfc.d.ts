// Minimal ambient typings for the experimental Web NFC API (Android Chrome only).
// Not part of lib.dom.d.ts. Kept narrow to what Receipt Tag uses.

interface NDEFRecordInit {
  recordType: string;
  data?: string | BufferSource;
  encoding?: string;
  lang?: string;
}

interface NDEFMessageInit {
  records: NDEFRecordInit[];
}

interface NDEFRecord {
  readonly recordType: string;
  readonly encoding?: string;
  readonly data?: DataView;
}

interface NDEFMessage {
  readonly records: readonly NDEFRecord[];
}

interface NDEFReadingEvent extends Event {
  readonly serialNumber?: string;
  readonly message: NDEFMessage;
}

interface NDEFWriteOptions {
  signal?: AbortSignal;
}

interface NDEFScanOptions {
  signal?: AbortSignal;
}

interface NDEFReaderEventMap {
  reading: NDEFReadingEvent;
  readingerror: Event;
}

declare class NDEFReader extends EventTarget {
  constructor();
  scan(options?: NDEFScanOptions): Promise<void>;
  write(message: NDEFMessageInit, options?: NDEFWriteOptions): Promise<void>;
  addEventListener<K extends keyof NDEFReaderEventMap>(
    type: K,
    listener: (this: NDEFReader, ev: NDEFReaderEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof NDEFReaderEventMap>(
    type: K,
    listener: (this: NDEFReader, ev: NDEFReaderEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface Window {
  NDEFReader?: typeof NDEFReader;
}
