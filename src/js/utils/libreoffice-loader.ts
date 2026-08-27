/**
 * LibreOffice WASM Converter Wrapper
 *
 * Uses @matbee/libreoffice-converter package for document conversion.
 * Handles progress tracking and provides simpler API.
 */

import { WorkerBrowserConverter } from '@matbee/libreoffice-converter/browser';
import type { InputFormat } from '@matbee/libreoffice-converter/browser';

const LIBREOFFICE_LOCAL_PATH =
  import.meta.env.VITE_WASM_LIBREOFFICE_URL ||
  '/libreoffice-wasm/';

/*
 * IMPORTANT:
 *
 * LibreOffice WASM/data can be loaded from R2/CDN.
 * However, browser Worker scripts must be same-origin.
 *
 * Therefore:
 *   - soffice.wasm.gz  -> basePath (R2 or local)
 *   - soffice.data.gz  -> basePath (R2 or local)
 *   - soffice.js        -> same-origin
 *   - soffice.worker.js -> same-origin
 *   - browser.worker.global.js -> same-origin
 *
 * This prevents:
 *
 * SecurityError:
 * Script at 'https://...r2.dev/...'
 * cannot be accessed from origin 'https://pdf.veloxity.org'
 */

const LIBREOFFICE_WORKER_PATH = `${import.meta.env.BASE_URL}libreoffice-wasm/`;

export interface LoadProgress {
  phase: 'loading' | 'initializing' | 'converting' | 'complete' | 'ready';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: LoadProgress) => void;

// Singleton for converter instance
let converterInstance: LibreOfficeConverter | null = null;

const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

async function fetchAsDecompressedUrl(
  url: string,
  mimeType: string
): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: HTTP ${response.status}`
    );
  }

  let blob = await response.blob();

  const head = new Uint8Array(
    await blob.slice(0, 2).arrayBuffer()
  );

  if (
    head[0] === GZIP_MAGIC_FIRST &&
    head[1] === GZIP_MAGIC_SECOND
  ) {
    const decompressed = blob
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));

    blob = await new Response(decompressed).blob();
  }

  return URL.createObjectURL(
    new Blob([blob], { type: mimeType })
  );
}

export class LibreOfficeConverter {
  private converter: WorkerBrowserConverter | null = null;
  private initialized = false;
  private initializing = false;
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath =
      basePath || LIBREOFFICE_LOCAL_PATH;
  }

  async initialize(
    onProgress?: ProgressCallback
  ): Promise<void> {
    if (this.initialized) return;

    if (this.initializing) {
      while (this.initializing) {
        await new Promise((r) =>
          setTimeout(r, 100)
        );
      }

      return;
    }

    this.initializing = true;

    let progressCallback = onProgress;

    try {
      progressCallback?.({
        phase: 'loading',
        percent: 0,
        message: 'Loading conversion engine...',
      });

      /*
       * WASM and data files.
       *
       * These may come from R2/CDN.
       */
      const [sofficeWasmUrl, sofficeDataUrl] =
        await Promise.all([
          fetchAsDecompressedUrl(
            `${this.basePath}soffice.wasm.gz`,
            'application/wasm'
          ),

          fetchAsDecompressedUrl(
            `${this.basePath}soffice.data.gz`,
            'application/octet-stream'
          ),
        ]);

      /*
       * IMPORTANT:
       *
       * Worker JavaScript files are deliberately loaded
       * from the same origin as the application.
       *
       * Do NOT change these back to this.basePath.
       */
      const workerBase =
        LIBREOFFICE_WORKER_PATH.endsWith('/')
          ? LIBREOFFICE_WORKER_PATH
          : `${LIBREOFFICE_WORKER_PATH}/`;

      const sofficeJs =
        `${workerBase}soffice.js`;

      const sofficeWorkerJs =
        `${workerBase}soffice.worker.js`;

      const browserWorkerJs =
        `${workerBase}browser.worker.global.js`;

      console.log(
        '[LibreOffice] WASM/data base:',
        this.basePath
      );

      console.log(
        '[LibreOffice] Worker base:',
        workerBase
      );

      console.log(
        '[LibreOffice] soffice.js:',
        sofficeJs
      );

      console.log(
        '[LibreOffice] soffice.worker.js:',
        sofficeWorkerJs
      );

      console.log(
        '[LibreOffice] browser.worker.global.js:',
        browserWorkerJs
      );

      this.converter =
        new WorkerBrowserConverter({
          /*
           * Same-origin worker files.
           */
          sofficeJs,
          sofficeWorkerJs,
          browserWorkerJs,

          /*
           * Decompressed blob URLs for WASM/data.
           */
          sofficeWasm: sofficeWasmUrl,
          sofficeData: sofficeDataUrl,

          verbose: false,

          onProgress: (info: {
            phase: string;
            percent: number;
            message: string;
          }) => {
            if (
              progressCallback &&
              !this.initialized
            ) {
              const simplifiedMessage =
                `Loading conversion engine (${Math.round(
                  info.percent
                )}%)...`;

              progressCallback({
                phase:
                  info.phase as LoadProgress['phase'],
                percent: info.percent,
                message: simplifiedMessage,
              });
            }
          },

          onReady: () => {
            console.log(
              '[LibreOffice] Ready!'
            );
          },

          onError: (error: Error) => {
            console.error(
              '[LibreOffice] Error:',
              error
            );
          },
        });

      await this.converter.initialize();

      this.initialized = true;

      progressCallback?.({
        phase: 'ready',
        percent: 100,
        message: 'Conversion engine ready!',
      });

      progressCallback = undefined;
    } finally {
      this.initializing = false;
    }
  }

  isReady(): boolean {
    return (
      this.initialized &&
      this.converter !== null
    );
  }

  async convertToPdf(
    file: File
  ): Promise<Blob> {
    if (!this.converter) {
      throw new Error(
        'Converter not initialized'
      );
    }

    console.log(
      `[LibreOffice] Converting ${file.name} to PDF...`
    );

    console.log(
      `[LibreOffice] File type: ${file.type}, Size: ${file.size} bytes`
    );

    try {
      console.log(
        '[LibreOffice] Reading file as ArrayBuffer...'
      );

      const arrayBuffer =
        await file.arrayBuffer();

      const uint8Array =
        new Uint8Array(arrayBuffer);

      console.log(
        `[LibreOffice] File loaded, ${uint8Array.length} bytes`
      );

      console.log(
        '[LibreOffice] Calling converter.convert() with buffer...'
      );

      const startTime = Date.now();

      /*
       * Detect input format from file extension.
       *
       * This is particularly important for CSV,
       * because LibreOffice needs the input format
       * to apply the correct import filter.
       */
      const ext =
        file.name
          .split('.')
          .pop()
          ?.toLowerCase() || '';

      console.log(
        `[LibreOffice] Detected format from extension: ${ext}`
      );

      const result =
        await this.converter.convert(
          uint8Array,
          {
            outputFormat: 'pdf',
            inputFormat:
              ext as InputFormat,
          },
          file.name
        );

      const duration =
        Date.now() - startTime;

      console.log(
        `[LibreOffice] Conversion complete! Duration: ${duration}ms, Size: ${result.data.length} bytes`
      );

      /*
       * Create a normal Uint8Array copy.
       *
       * This avoids SharedArrayBuffer type issues
       * when constructing the final Blob.
       */
      const data =
        new Uint8Array(result.data);

      return new Blob(
        [data],
        {
          type: result.mimeType,
        }
      );
    } catch (error) {
      console.error(
        `[LibreOffice] Conversion FAILED for ${file.name}:`,
        error
      );

      console.error(
        '[LibreOffice] Error details:',
        {
          message:
            error instanceof Error
              ? error.message
              : String(error),

          stack:
            error instanceof Error
              ? error.stack
              : undefined,
        }
      );

      throw error;
    }
  }

  async wordToPdf(
    file: File
  ): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async pptToPdf(
    file: File
  ): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async excelToPdf(
    file: File
  ): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async destroy(): Promise<void> {
    if (this.converter) {
      await this.converter.destroy();
    }

    this.converter = null;
    this.initialized = false;
  }
}

export function getLibreOfficeConverter(
  basePath?: string
): LibreOfficeConverter {
  if (!converterInstance) {
    converterInstance =
      new LibreOfficeConverter(basePath);
  }

  return converterInstance;
}
