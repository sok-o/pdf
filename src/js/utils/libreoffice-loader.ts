/**
 * LibreOffice WASM Converter Wrapper
 *
 * Uses @matbee/libreoffice-converter package for document conversion.
 *
 * Deployment architecture:
 *
 *   R2:
 *     soffice.wasm.gz
 *     soffice.data.gz
 *
 *   Same-origin Cloudflare Pages:
 *     soffice.js
 *     soffice.worker.js
 *     browser.worker.global.js
 *
 * The Worker JavaScript files MUST be same-origin because browsers
 * do not allow a Worker to be constructed from a different origin.
 *
 * The large WASM/data files can be fetched from R2.
 */

import { WorkerBrowserConverter } from '@matbee/libreoffice-converter/browser';
import type { InputFormat } from '@matbee/libreoffice-converter/browser';

const LIBREOFFICE_R2_PATH =
  import.meta.env.VITE_WASM_LIBREOFFICE_URL ||
  'https://pub-765ae27e5d3a4d09bda67cabc7470e15.r2.dev/libreoffice-wasm/';

/**
 * Same-origin path used for the JavaScript worker/runtime files.
 *
 * These files must exist in the deployed site:
 *
 *   /libreoffice-wasm/soffice.js
 *   /libreoffice-wasm/soffice.worker.js
 *   /libreoffice-wasm/browser.worker.global.js
 */
const LIBREOFFICE_LOCAL_PATH =
  `${import.meta.env.BASE_URL}libreoffice-wasm/`;

export interface LoadProgress {
  phase:
    | 'loading'
    | 'initializing'
    | 'converting'
    | 'complete'
    | 'ready';

  percent: number;
  message: string;
}

export type ProgressCallback =
  (progress: LoadProgress) => void;

// Singleton for converter instance
let converterInstance:
  LibreOfficeConverter | null = null;

const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

/**
 * Fetch a gzip-compressed WASM/data file from R2,
 * decompress it in the browser, and return a Blob URL.
 *
 * This avoids requiring the browser to execute the
 * gzip file directly as WASM.
 */
async function fetchAsDecompressedUrl(
  url: string,
  mimeType: string
): Promise<string> {
  console.log(
    `[LibreOffice] Fetching: ${url}`
  );

  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    cache: 'force-cache',
  });

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
    console.log(
      `[LibreOffice] Decompressing gzip asset: ${url}`
    );

    if (
      typeof DecompressionStream ===
      'undefined'
    ) {
      throw new Error(
        'This browser does not support DecompressionStream.'
      );
    }

    const decompressed =
      blob
        .stream()
        .pipeThrough(
          new DecompressionStream('gzip')
        );

    blob = await new Response(
      decompressed
    ).blob();
  }

  const objectUrl =
    URL.createObjectURL(
      new Blob([blob], {
        type: mimeType,
      })
    );

  console.log(
    `[LibreOffice] Created local Blob URL for ${url}`
  );

  return objectUrl;
}

export class LibreOfficeConverter {
  private converter:
    | WorkerBrowserConverter
    | null = null;

  private initialized = false;
  private initializing = false;

  constructor() {}

  async initialize(
    onProgress?: ProgressCallback
  ): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      while (this.initializing) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100)
        );
      }

      return;
    }

    this.initializing = true;

    let progressCallback =
      onProgress;

    try {
      progressCallback?.({
        phase: 'loading',
        percent: 0,
        message:
          'Loading conversion engine...',
      });

      /*
       * ---------------------------------------------------------
       * 1. Fetch the large WASM/data files from R2.
       * ---------------------------------------------------------
       */

      const wasmBase =
        LIBREOFFICE_R2_PATH.endsWith('/')
          ? LIBREOFFICE_R2_PATH
          : `${LIBREOFFICE_R2_PATH}/`;

      console.log(
        '[LibreOffice] R2 base:',
        wasmBase
      );

      const [
        sofficeWasmUrl,
        sofficeDataUrl,
      ] = await Promise.all([
        fetchAsDecompressedUrl(
          `${wasmBase}soffice.wasm.gz`,
          'application/wasm'
        ),

        fetchAsDecompressedUrl(
          `${wasmBase}soffice.data.gz`,
          'application/octet-stream'
        ),
      ]);

      /*
       * ---------------------------------------------------------
       * 2. Use SAME-ORIGIN JavaScript worker files.
       * ---------------------------------------------------------
       *
       * These MUST NOT point to R2.
       */

      const localBase =
        LIBREOFFICE_LOCAL_PATH.endsWith('/')
          ? LIBREOFFICE_LOCAL_PATH
          : `${LIBREOFFICE_LOCAL_PATH}/`;

      const sofficeJs =
        `${localBase}soffice.js`;

      const sofficeWorkerJs =
        `${localBase}soffice.worker.js`;

      const browserWorkerJs =
        `${localBase}browser.worker.global.js`;

      console.log(
        '[LibreOffice] Same-origin worker base:',
        localBase
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

      /*
       * ---------------------------------------------------------
       * 3. Verify that the worker files are actually reachable.
       * ---------------------------------------------------------
       *
       * This converts the previous vague "Worker load timeout"
       * into a useful error if Cloudflare is returning 404/HTML.
       */

      const workerUrls = [
        sofficeJs,
        sofficeWorkerJs,
        browserWorkerJs,
      ];

      for (const workerUrl of workerUrls) {
        console.log(
          `[LibreOffice] Checking worker: ${workerUrl}`
        );

        const response = await fetch(
          workerUrl,
          {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
          }
        );

        if (!response.ok) {
          throw new Error(
            `LibreOffice worker file is not accessible: ${workerUrl} (HTTP ${response.status})`
          );
        }

        const contentType =
          response.headers.get(
            'content-type'
          ) || '';

        console.log(
          `[LibreOffice] Worker response: ${workerUrl} -> ${response.status} ${contentType}`
        );

        /*
         * Cloudflare Pages can return HTML for a
         * missing asset through fallback routing.
         *
         * Catch that here instead of allowing Worker()
         * to eventually time out.
         */
        if (
          contentType.includes('text/html')
        ) {
          throw new Error(
            `LibreOffice worker URL returned HTML instead of JavaScript: ${workerUrl}`
          );
        }
      }

      progressCallback?.({
        phase: 'initializing',
        percent: 50,
        message:
          'Initialising conversion engine...',
      });

      /*
       * ---------------------------------------------------------
       * 4. Create the browser converter.
       * ---------------------------------------------------------
       */

      this.converter =
        new WorkerBrowserConverter({
          /*
           * SAME-ORIGIN JS files
           */
          sofficeJs,
          sofficeWorkerJs,
          browserWorkerJs,

          /*
           * R2 WASM/data converted to local Blob URLs
           */
          sofficeWasm:
            sofficeWasmUrl,

          sofficeData:
            sofficeDataUrl,

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
              progressCallback({
                phase:
                  info.phase as LoadProgress['phase'],

                percent:
                  info.percent,

                message:
                  `Loading conversion engine (${Math.round(
                    info.percent
                  )}%)...`,
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
              '[LibreOffice] Worker error:',
              error
            );
          },
        });

      /*
       * ---------------------------------------------------------
       * 5. Initialise LibreOffice.
       * ---------------------------------------------------------
       */

      await this.converter.initialize();

      this.initialized = true;

      progressCallback?.({
        phase: 'ready',
        percent: 100,
        message:
          'Conversion engine ready!',
      });

      progressCallback = undefined;

      console.log(
        '[LibreOffice] Initialisation complete.'
      );
    } catch (error) {
      console.error(
        '[LibreOffice] Initialisation FAILED:',
        error
      );

      /*
       * Reset state so a later attempt can retry.
       */
      this.converter = null;
      this.initialized = false;

      throw error;
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
      const arrayBuffer =
        await file.arrayBuffer();

      const uint8Array =
        new Uint8Array(
          arrayBuffer
        );

      console.log(
        `[LibreOffice] File loaded: ${uint8Array.length} bytes`
      );

      const ext =
        file.name
          .split('.')
          .pop()
          ?.toLowerCase() || '';

      console.log(
        `[LibreOffice] Input format: ${ext}`
      );

      const startTime =
        Date.now();

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
        `[LibreOffice] Conversion complete in ${duration}ms`
      );

      console.log(
        `[LibreOffice] Output size: ${result.data.length} bytes`
      );

      /*
       * Always copy the result into an ordinary
       * Uint8Array before creating the Blob.
       */
      const data =
        new Uint8Array(
          result.data
        );

      return new Blob(
        [data],
        {
          type:
            result.mimeType ||
            'application/pdf',
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
    this.initializing = false;
  }
}

export function getLibreOfficeConverter(
  _basePath?: string
): LibreOfficeConverter {
  if (!converterInstance) {
    converterInstance =
      new LibreOfficeConverter();
  }

  return converterInstance;
}
