import type { AstroConfig, CollectionResult, CollectionRSS, CreateCollection, Params } from '../@types/astro';
import type { CompileOptions } from '../@types/compiler';
import type { AstroRuntime, LoadResult, RuntimeConfig, RuntimeOptions } from '../@types/runtime';

import { CompileError } from '@astrojs/parser';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import mime from 'mime';
import { posix as path } from 'path';
import { performance } from 'perf_hooks';
import { createServer as createViteServer } from 'vite';
import { canonicalURL, getSrcPath, stopTimer } from '../build/util.js';
import { debug, info } from '../logger.js';
import { NotFoundError } from './error.js';
import { ASTRO_FRONTEND, loadInternalFile } from './internal.js';
import { CJS_EXTERNALS, ESM_EXTERNALS } from './modules.js';
import { searchForPage } from './search.js';
import { createStaticServer, loadStaticFile } from './static.js';
import astro from './vite_plugin.js';

// info needed for collection generatio
/** Pass a URL to Astro to resolve and build */
async function load(config: RuntimeConfig, rawPathname: string | undefined): Promise<LoadResult> {
  const { logging, staticServer, viteServer } = config;
  const { buildOptions, devOptions } = config.astroConfig;

  let origin = buildOptions.site ? new URL(buildOptions.site).origin : `http://localhost:${devOptions.port}`;
  const fullurl = new URL(rawPathname || '/', origin);

  let reqPath = decodeURI(fullurl.pathname);
  if (reqPath.endsWith('/')) reqPath += 'index.html';
  info(logging, 'access', reqPath);

  // static files
  try {
    const result = await loadStaticFile(reqPath, { server: staticServer });
    if (result.statusCode === 200) return result;
  } catch (err) {
    // don’t throw yet; attempt other lookups before returning 404
  }

  // Astro internal
  if (reqPath.startsWith(ASTRO_FRONTEND)) {
    return await loadInternalFile(reqPath);
  }

  // Astro pages
  const searchResult = searchForPage(fullurl, config.astroConfig);
  if (searchResult.statusCode === 404) {
    try {
      const result = await viteServer.transformRequest(reqPath);
      if (!result) throw new Error(`Unable to load ${reqPath}`);
      // success
      return {
        statusCode: 200,
        contents: typeof result === 'string' ? result : `${result.code}`,
        contentType: mime.getType(reqPath) || 'text/plain',
      };
    } catch (err) {
      // build error
      if (err.failed) {
        return { statusCode: 500, type: 'unknown', error: err };
      }

      // not found
      return { statusCode: 404, error: err };
    }
  }

  if (searchResult.statusCode === 301) {
    return { statusCode: 301, location: searchResult.pathname };
  }

  let rss: { data: any[] & CollectionRSS } = {} as any;

  // other resources
  try {
    const mod = await viteServer.ssrLoadModule(fileURLToPath(searchResult.location));

    // handle collection
    let collection = {} as CollectionResult;
    let additionalURLs = new Set<string>();

    if (mod.createCollection) {
      const createCollection: CreateCollection = await mod.createCollection();
      const VALID_KEYS = new Set(['data', 'routes', 'permalink', 'pageSize', 'rss']);
      for (const key of Object.keys(createCollection)) {
        if (!VALID_KEYS.has(key)) {
          throw new Error(`[createCollection] unknown option: "${key}". Expected one of ${[...VALID_KEYS].join(', ')}.`);
        }
      }
      let { data: loadData, routes, permalink, pageSize, rss: createRSS } = createCollection;
      if (!loadData) throw new Error(`[createCollection] must return \`data()\` function to create a collection.`);
      if (!pageSize) pageSize = 25; // can’t be 0
      let currentParams: Params = {};

      // params
      if (routes || permalink) {
        if (!routes) throw new Error('[createCollection] `permalink` requires `routes` as well.');
        if (!permalink) throw new Error('[createCollection] `routes` requires `permalink` as well.');

        let requestedParams = routes.find((p) => {
          const baseURL = (permalink as any)({ params: p });
          additionalURLs.add(baseURL);
          return baseURL === reqPath || `${baseURL}/${searchResult.currentPage || 1}` === reqPath;
        });
        if (requestedParams) {
          currentParams = requestedParams;
          collection.params = requestedParams;
        }
      }

      let data: any[] = await loadData({ params: currentParams });
      if (!data) throw new Error(`[createCollection] \`data()\` returned nothing (empty data)"`);
      if (!Array.isArray(data)) data = [data]; // note: this is supposed to be a little friendlier to the user, but should we error out instead?

      // handle RSS
      if (createRSS) {
        rss = {
          ...createRSS,
          data: [...data] as any,
        };
      }

      collection.start = 0;
      collection.end = data.length - 1;
      collection.total = data.length;
      collection.page = { current: 1, size: pageSize, last: 1 };
      collection.url = { current: reqPath };

      // paginate
      if (searchResult.currentPage) {
        const start = pageSize === Infinity ? 0 : (searchResult.currentPage - 1) * pageSize; // currentPage is 1-indexed
        const end = Math.min(start + pageSize, data.length);

        collection.start = start;
        collection.end = end - 1;
        collection.page.current = searchResult.currentPage;
        collection.page.last = Math.ceil(data.length / pageSize);
        // TODO: fix the .replace() hack
        if (end < data.length) {
          collection.url.next = collection.url.current.replace(/(\/\d+)?$/, `/${searchResult.currentPage + 1}`);
        }
        if (searchResult.currentPage > 1) {
          collection.url.prev = collection.url.current
            .replace(/\d+$/, `${searchResult.currentPage - 1 || 1}`) // update page #
            .replace(/\/1$/, ''); // if end is `/1`, then just omit
        }

        // from page 2 to the end, add all pages as additional URLs (needed for build)
        for (let n = 1; n <= collection.page.last; n++) {
          if (additionalURLs.size) {
            // if this is a param-based collection, paginate all params
            additionalURLs.forEach((url) => {
              additionalURLs.add(url.replace(/(\/\d+)?$/, `/${n}`));
            });
          } else {
            // if this has no params, simply add page
            additionalURLs.add(reqPath.replace(/(\/\d+)?$/, `/${n}`));
          }
        }

        data = data.slice(start, end);
      } else if (createCollection.pageSize) {
        // TODO: fix bug where redirect doesn’t happen
        // This happens because a pageSize is set, but the user isn’t on a paginated route. Redirect:
        return {
          statusCode: 301,
          location: reqPath + '/1',
          collectionInfo: {
            additionalURLs,
            rss: rss.data ? rss : undefined,
          },
        };
      }

      // if we’ve paginated too far, this is a 404
      if (!data.length) {
        return {
          statusCode: 404,
          error: new Error('Not Found'),
          collectionInfo: {
            additionalURLs,
            rss: rss.data ? rss : undefined,
          },
        };
      }

      collection.data = data;
    }

    const requestURL = new URL(fullurl.toString());

    // For first release query params are not passed to components.
    // An exception is made for dev server specific routes.
    if (reqPath !== '/500') {
      requestURL.search = '';
    }

    let html = await mod.__renderPage({
      request: {
        // params should go here when implemented
        url: requestURL,
        canonicalURL: canonicalURL(requestURL.pathname, requestURL.origin),
      },
      children: [],
      props: Object.keys(collection).length > 0 ? { collection } : {},
      css: Array.isArray(mod.css) ? mod.css : typeof mod.css === 'string' ? [mod.css] : [],
    });

    return {
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      contents: html,
      collectionInfo: {
        additionalURLs,
        rss: rss.data ? rss : undefined,
      },
    };
  } catch (err) {
    if (err.code === 'parse-error' || err instanceof SyntaxError) {
      return {
        statusCode: 500,
        type: 'parse-error',
        error: err,
      };
    }

    if (err instanceof ReferenceError && err.toString().includes('window is not defined')) {
      return {
        statusCode: 500,
        type: 'ssr',
        error: new Error(
          `[${reqPath}]
    The window object is not available during server-side rendering (SSR).
    Try using \`import.meta.env.SSR\` to write SSR-friendly code.
    https://docs.astro.build/reference/api-reference/#importmeta`
        ),
      };
    }

    if (err instanceof NotFoundError && rawPathname) {
      const fileMatch = err.toString().match(/\(([^\)]+)\)/);
      const missingFile: string | undefined = (fileMatch && fileMatch[1].replace(/^\/_astro/, '').replace(/\.proxy\.js$/, '')) || undefined;
      const distPath = path.extname(rawPathname) ? rawPathname : rawPathname.replace(/\/?$/, '/index.html');
      const srcFile = getSrcPath(distPath, { astroConfig: config.astroConfig });
      const code = existsSync(srcFile) ? await fs.readFile(srcFile, 'utf8') : '';

      // try and find the import statement within the module. this is a bit hacky, as we don’t know the line, but
      // given that we know this is for sure a “not found” error, and we know what file is erring,
      // we can make some safe assumptions about how to locate the line in question
      let start = 0;
      const segments = missingFile ? missingFile.split('/').filter((segment) => !!segment) : [];
      while (segments.length) {
        const importMatch = code.indexOf(segments.join('/'));
        if (importMatch >= 0) {
          start = importMatch;
          break;
        }
        segments.shift();
      }

      return {
        statusCode: 500,
        type: 'not-found',
        error: new CompileError({
          code,
          filename: srcFile.pathname,
          start,
          message: `Could not find${missingFile ? ` "${missingFile}"` : ' file'}`,
        }),
      };
    }

    return {
      statusCode: 500,
      type: 'unknown',
      error: err,
    };
  }
}
/** Create a new Vite instance to power Astro */
async function createVite(astroConfig: AstroConfig, compileOptions: CompileOptions) {
  // Tailwind: IDK what this does but it makes JIT work 🤷‍♂️
  if (astroConfig.devOptions.tailwindConfig) {
    (process.env as any).TAILWIND_DISABLE_TOUCH = true;
  }

  return createViteServer({
    root: fileURLToPath(astroConfig.projectRoot),
    logLevel: 'error',
    mode: compileOptions.mode,
    ssr: {
      external: [...CJS_EXTERNALS],
      noExternal: [...ESM_EXTERNALS],
    },
    plugins: [astro(compileOptions)],
  } as any);
}

/** Core Astro runtime */
export async function createRuntime(astroConfig: AstroConfig, { mode, logging }: RuntimeOptions): Promise<AstroRuntime> {
  const timer: Record<string, number> = {};

  timer.backend = performance.now();
  const [viteServer, staticServer] = await Promise.all([
    createVite(astroConfig, {
      astroConfig,
      logging,
      mode,
    }),
    createStaticServer(astroConfig),
  ]);
  debug(logging, 'core', `snowpack created [${stopTimer(timer.backend)}]`);

  const runtimeConfig: RuntimeConfig = {
    astroConfig,
    logging,
    mode,
    viteServer,
    staticServer,
  };

  return {
    runtimeConfig,
    load: load.bind(null, runtimeConfig),
    async shutdown() {
      staticServer.stop();
    },
  };
}
