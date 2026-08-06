// A fake D1 binding for testing the data layer's QUERY COMPOSITION — which
// SQL ran, with which binds, in which batches. It does not execute SQL (a
// reimplementation of SQLite would test the fake, not the code); rows come
// from a caller-supplied responder keyed on a substring of the statement.
//
// Lives in testkit/ (not test/) for the same reason registryHarness does:
// `node --test` would report a helper file as an empty passing test.

export function createFakeD1({ respond = () => null } = {}) {
  const executed = []; // { sql, binds, via: 'run'|'first'|'batch' }

  const statement = (sql) => {
    let binds = [];
    const self = {
      bind(...args) {
        binds = args;
        return self;
      },
      async first() {
        executed.push({ sql, binds, via: 'first' });
        return respond(sql, binds);
      },
      async run() {
        executed.push({ sql, binds, via: 'run' });
        return { success: true };
      },
      // batch() collects the statement without executing; the fake's batch
      // marks them so atomicity expectations are assertable.
      _take(via) {
        executed.push({ sql, binds, via });
      },
    };
    return self;
  };

  return {
    executed,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      for (const s of statements) s._take('batch');
      return statements.map(() => ({ success: true }));
    },
  };
}
