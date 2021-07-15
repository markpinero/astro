import type { AstroConfig } from '../@types/astro';
import type { LoadResult } from '../@types/runtime';

import { serve as createEsbuildServer, ServeResult } from 'esbuild';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

/** Use esbuild as a static server */
export async function createStaticServer(astroConfig: AstroConfig) {
  return createEsbuildServer(
    {
      servedir: fileURLToPath(astroConfig.public),
    },
    {
      platform: 'node',
    }
  );
}

interface LoadStaticFileOptions {
  server: ServeResult;
}

/** Request static file via URL */
export async function loadStaticFile(url: string, { server }: LoadStaticFileOptions): Promise<LoadResult> {
  const result = await fetch(`http://${server.host}/${server.port}${url}`);
  return {
    contents: result.body as any,
    contentType: result.headers.get('content-type') as any,
    statusCode: result.status as any,
  };
}
