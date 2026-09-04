import { createRequire } from 'node:module';

// oxigraph is an optional native dependency, only needed for the knowledge-graph
// feature. Load it synchronously via createRequire: a top-level `await import`
// would make this module (and every module importing it, including the SQLite
// service) an async ESM graph, which cannot be require()d by CommonJS consumers.
let oxigraph;
try {
  oxigraph = createRequire(import.meta.url)('oxigraph');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

import { pipeline } from 'node:stream/promises';
import { text } from 'node:stream/consumers';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';

import cds from '@sap/cds';
const { path } = cds.utils;

const formats = {
  '.jsonld': 'application/ld+json',
  '.nq': 'application/n-quads',
  '.nt': 'application/n-triples',
  '.rdf': 'application/rdf+xml',
  '.trig': 'application/trig',
  '.ttl': 'text/turtle'
};

export default class TripleStore extends (oxigraph?.Store || class Store {}) {
  async load(file, graph) {
    this._ready();

    const root = await realpath(path.resolve(cds.root));
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Cannot load RDF data from outside the project: ${file}`);
    }

    let ext = path.extname(resolved).toLowerCase();
    if (ext.endsWith('.gz')) {
      ext = path.extname(resolved.slice(0, -3)).toLowerCase();
    }
    const format = formats[ext];
    if (!format) throw new Error(`Unsupported RDF file format: ${ext || '(none)'}`);

    // Resolve the target before opening it: a project-local symlink must not make
    // files outside of cds.root available through SPARQL LOAD.
    const target = await realpath(resolved);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Cannot load RDF data from outside the project: ${file}`);
    }

    const graphNode = graph == null ? oxigraph.defaultGraph() : oxigraph.namedNode(graph);
    const steps = [createReadStream(target)];
    if (path.extname(resolved).toLowerCase() === '.gz') steps.push(createGunzip());
    steps.push(text);
    return super.load(await pipeline(...steps), { format, to_graph_name: graphNode });
  }

  query(query, headers) {
    this._ready();

    const accept = (
      headers?.split('\r\n').find((header) => /accept:/i.test(header)) ??
      'accept:application/sparql-results+json'
    )
      .replace(/accept:/i, '')
      .trim(); // strip HTTP header formatting

    const RESPONSE = super.query(query, {
      use_default_graph_as_union: true,
      results_format: accept
    });
    return { RESPONSE };
  }

  async execute(query, headers) {
    this._ready();

    if (!/^\s*LOAD\b/i.test(query)) return this.query(query, headers);

    const match = /^\s*LOAD\s+<([^>]*)>(?:\s+INTO\s+GRAPH\s+<([^>]*)>)?\s*$/i.exec(query);
    if (!match) throw new Error(`Unsupported LOAD syntax: ${query}`);
    return this.load(match[1], match[2]);
  }

  _ready() {
    if (!oxigraph)
      throw new Error(`Cannot find 'oxigraph'. Make sure to install it with 'npm i oxigraph'`);
  }
}
