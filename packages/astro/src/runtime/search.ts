import type { AstroConfig } from '../@types/astro';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import glob from 'tiny-glob/sync.js';

/** findAnyPage and return the _astro candidate for snowpack */
function findAnyPage(candidates: Array<string>, astroConfig: AstroConfig): URL | false {
  for (let candidate of candidates) {
    const url = new URL(`./${candidate}`, astroConfig.pages);
    if (existsSync(url)) {
      return url;
    }
  }
  return false;
}

type SearchResult =
  | {
      statusCode: 200;
      location: URL;
      pathname: string;
      currentPage?: number;
    }
  | {
      statusCode: 301;
      location: null;
      pathname: string;
    }
  | {
      statusCode: 404;
    };

/** Given a URL, attempt to locate its source file (similar to Snowpack’s load()) */
export function searchForPage(url: URL, astroConfig: AstroConfig): SearchResult {
  const reqPath = decodeURI(url.pathname);
  const base = reqPath.substr(1);

  // Try to find index.astro/md paths
  if (reqPath.endsWith('/')) {
    const candidates = [`${base}index.astro`, `${base}index.md`];
    const location = findAnyPage(candidates, astroConfig);
    if (location) {
      return {
        statusCode: 200,
        location,
        pathname: reqPath,
      };
    }
  } else {
    // Try to find the page by its name.
    const candidates = [`${base}.astro`, `${base}.md`];
    let location = findAnyPage(candidates, astroConfig);
    if (location) {
      return {
        statusCode: 200,
        location,
        pathname: reqPath,
      };
    }
  }

  // Try to find name/index.astro/md
  const candidates = [`${base}/index.astro`, `${base}/index.md`];
  const location = findAnyPage(candidates, astroConfig);
  if (location) {
    return {
      statusCode: 301,
      location: null,
      pathname: reqPath + '/',
    };
  }

  // Try and load collections (but only for non-extension files)
  const hasExt = !!path.extname(reqPath);
  if (!location && !hasExt) {
    const collection = loadCollection(reqPath, astroConfig);
    if (collection) {
      return {
        statusCode: 200,
        location: collection.location,
        pathname: reqPath,
        currentPage: collection.currentPage || 1,
      };
    }
  }

  if (reqPath === '/500') {
    return {
      statusCode: 200,
      location: new URL('./frontend/500.astro', import.meta.url),
      pathname: reqPath,
    };
  }

  return {
    statusCode: 404,
  };
}

/** load a collection route */
function loadCollection(url: string, astroConfig: AstroConfig): { currentPage?: number; location: URL } | undefined {
  const pages = glob('**/$*.astro', { cwd: fileURLToPath(astroConfig.pages), filesOnly: true });
  for (const pageURL of pages) {
    const reqURL = new RegExp('^/' + pageURL.replace(/\$([^/]+)\.astro/, '$1') + '(?:/(.*)|/?$)');
    const match = url.match(reqURL);
    if (match) {
      let currentPage: number | undefined;
      if (match[1]) {
        const segments = match[1].split('/').filter((s) => !!s);
        if (segments.length) {
          const last = segments.pop() as string;
          if (parseInt(last, 10)) {
            currentPage = parseInt(last, 10);
          }
        }
      }
      const pagesPath = astroConfig.pages.pathname.replace(astroConfig.projectRoot.pathname, '');
      return {
        location: new URL(`./${pageURL}`, astroConfig.pages),
        currentPage,
      };
    }
  }
}
