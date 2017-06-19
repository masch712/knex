'use strict';
var Promise    = require('bluebird')
var harness    = require('./harness')
var tape       = require('tape')
var JSONStream = require('JSONStream')

//TODO: test committing many nested transactions too?
//TODO: test sibling PARALLEL (i.e. promise.all style) transactions can't see each other's shit rollback in expected ways
//    In order to get this to pass, I'll probably have to keep connections until the outerTx is released

module.exports = function(knex) {

  tape(knex.client.driverName + ' - transactions: before', function(t) {
    knex.schema.dropTableIfExists('test_table')
      .createTable('test_table', function(t) {
        t.integer('id')
        t.string('name')
      })
      .then(function() {
        t.end()
      })
  })

  var test = harness('test_table', knex)

  test('transaction', function (t) {
    return knex.transaction(function(trx) {
      return trx.insert({id: 1, name: 'A'}).into('test_table')
    })
    .then(function() {
      return knex.select('*').from('test_table').then(function(results) {
        t.equal(results.length, 1, 'One row inserted')
      })
    })
  })

  test('transaction rollback on returned rejected promise', function (t) {
    var testError = new Error('Not inserting')
    var trxQueryCount = 0
    var trxRejected
    return knex.transaction(function (trx) {
      return trx.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        throw testError
      })
    })
    .on('query', function () {
      ++trxQueryCount
    })
    .catch(function (err) {
      t.equal(err, testError, 'Expected error reported')
      trxRejected = true
    })
    .finally(function () {
      // BEGIN, INSERT, ROLLBACK
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedQueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      t.equal(trxQueryCount, expectedQueryCount, 'Expected number of transaction SQL queries executed')
      t.equal(trxRejected, true, 'Transaction promise rejected')
      return knex.select('*').from('test_table').then(function (results) {
        t.equal(results.length, 0, 'No rows inserted')
      })
    })
  })

  test('transaction rollback on error throw', function (t) {
    var testError = new Error('Boo!!!')
    var trxQueryCount = 0
    var trxRejected
    return knex.transaction(function () {
      throw testError
    })
    .on('query', function () {
      ++trxQueryCount
    })
    .catch(function (err) {
      t.equal(err, testError, 'Expected error reported')
      trxRejected = true;
    })
    .finally(function () {
      // BEGIN, ROLLBACK
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedQueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 0 : 2
      t.equal(trxQueryCount, expectedQueryCount, 'Expected number of transaction SQL queries executed')
      t.equal(trxRejected, true, 'Transaction promise rejected')
    })
  })

  test('transaction savepoint rollback on returned rejected promise', function (t) {
    var testError = new Error('Rolling Back Savepoint')
    var trx1QueryCount = 0
    var trx2QueryCount = 0
    var trx2Rejected
    return knex.transaction(function (trx1) {
      return trx1.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        // Nested transaction (savepoint)
        return trx1.transaction(function (trx2) {
          // Insert and then roll back to savepoint
          return trx2.table('test_table').insert({id: 2, name: 'B'}).then(function () {
            return trx2('test_table').then(function (results) {
              t.equal(results.length, 2, 'Two rows inserted')
            })
            .throw(testError)
          })
        })
        .on('query', function () {
          ++trx2QueryCount
        })
      }).catch(function (err) {
        t.equal(err, testError, 'Expected error reported')
        trx2Rejected = true
      })
    })
    .on('query', function () {
      ++trx1QueryCount
    })
    .finally(function () {
      // trx1: BEGIN, INSERT, ROLLBACK
      // trx2: SAVEPOINT, INSERT, SELECT, ROLLBACK TO SAVEPOINT
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedTrx1QueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      var expectedTrx2QueryCount = 4
      expectedTrx1QueryCount += expectedTrx2QueryCount
      t.equal(trx1QueryCount, expectedTrx1QueryCount, 'Expected number of parent transaction SQL queries executed')
      t.equal(trx2QueryCount, expectedTrx2QueryCount, 'Expected number of nested transaction SQL queries executed')
      t.equal(trx2Rejected, true, 'Nested transaction promise rejected')
      return knex.select('*').from('test_table').then(function (results) {
        t.equal(results.length, 1, 'One row inserted')
      })
    })
  })

  test('transaction savepoint rollback on outer transaction returned rejected promise', function (t) {
    var testError = new Error('Rolling Back Savepoint')
    var trx1QueryCount = 0
    var trx2QueryCount = 0
    var trx1Rejected
    return knex.transaction(function (trx1) {
      return trx1.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        // Nested transaction (savepoint)
        return trx1.transaction(function (trx2) {
          // Insert and then roll back to savepoint
          return trx2.table('test_table').insert({id: 2, name: 'B'}).then(function () {
            return trx2('test_table').then(function (results) {
              t.equal(results.length, 2, 'Two rows inserted')
            })
          })
        })
        .on('query', function () {
          ++trx2QueryCount
        })
      }).then(function () {
        throw testError;
      })
    })
    .on('query', function () {
      ++trx1QueryCount
    }).catch(function (err) {
      t.equal(err, testError, 'Expected error reported')
      trx1Rejected = true
    })
    .finally(function () {
      // trx1: BEGIN, INSERT, ROLLBACK
      // trx2: SAVEPOINT, INSERT, SELECT
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedTrx1QueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      var expectedTrx2QueryCount = 3
      expectedTrx1QueryCount += expectedTrx2QueryCount
      t.equal(trx1QueryCount, expectedTrx1QueryCount, 'Expected number of parent transaction SQL queries executed')
      t.equal(trx2QueryCount, expectedTrx2QueryCount, 'Expected number of nested transaction SQL queries executed')
      t.equal(trx1Rejected, true, 'Outer transaction promise rejected')

      return knex.select('*').from('test_table').then(function (results) {
        t.equal(results.length, 0, 'Zero rows inserted')
      })
    })
  })



  test('doubly-nested, single-nested, and outer transactions all rollback on outer transaction returned rejected promise', function (t) {
    var testError = new Error('Rolling Back Savepoint')
    var trx1QueryCount = 0
    var trx2QueryCount = 0
    var trx3QueryCount = 0
    var trx1Rejected
    return knex.transaction(function (trx1) {
      return trx1.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        return trx1.transaction(function (trx2) {
          return trx2.table('test_table').insert({id: 2, name: 'B'}).then(function () {
            return trx2.transaction(function (trx3) {
              return trx3.table('test_table').insert({id: 3, name: 'C'}).then(function () {
                return trx3('test_table').then(function (results) {
                  t.equal(results.length, 3, 'Three rows inserted')
                })
              })
            })
            .on('query', function () {
              ++trx3QueryCount;
            })
          })
        })
        .on('query', function () {
          ++trx2QueryCount
        })
      }).then(function () {
        throw testError;
      })
    })
    .on('query', function () {
      ++trx1QueryCount
    }).catch(function (err) {
      t.equal(err, testError, 'Expected error reported')
      trx1Rejected = true
    })
    .finally(function () {
      // trx1: BEGIN, INSERT, ROLLBACK
      // trx2: SAVEPOINT, INSERT (savepoint rolledback and erased implicitly)
      // trx3: SAVEPOINT, INSERT, SELECT (savepoint rolledback and erased implicitly)
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedTrx1QueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      var expectedTrx2QueryCount = 2
      var expectedTrx3QueryCount = 3
      expectedTrx2QueryCount += expectedTrx3QueryCount;
      expectedTrx1QueryCount += expectedTrx2QueryCount
      t.equal(trx1QueryCount, expectedTrx1QueryCount, 'Expected number of parent transaction SQL queries executed')
      t.equal(trx2QueryCount, expectedTrx2QueryCount, 'Expected number of nested transaction SQL queries executed')
      t.equal(trx3QueryCount, expectedTrx3QueryCount, 'Expected number of nested transaction SQL queries executed')
      t.equal(trx1Rejected, true, 'Outer transaction promise rejected')
      return knex.select('*').from('test_table').then(function (results) {
        t.equal(results.length, 0, 'Zero rows inserted')
      })
    })
  })

  test('doubly-nested, single-nested, and outer transactions all rollback on single-nested transaction returned uncaught rejected promise', function (t) {
    var testError = new Error('Rolling Back Savepoint')
    var trx1QueryCount = 0
    var trx2QueryCount = 0
    var trx3QueryCount = 0
    var trx1Rejected
    return knex.transaction(function (trx1) {
      return trx1.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        // Nested transaction (savepoint)
        return trx1.transaction(function (trx2) {
          return trx2.table('test_table').insert({id: 2, name: 'B'}).then(function () {
            return trx2.transaction(function (trx3) {
              return trx3.table('test_table').insert({id: 3, name: 'C'}).then(function () {
                return trx3('test_table').then(function (results) {
                  t.equal(results.length, 3, 'Three rows inserted')
                })
              })
            })
            .on('query', function (query) {
              ++trx3QueryCount;
            }).then(function () {
              throw testError;
            });
          })
        })
        .on('query', function (query) {
          ++trx2QueryCount
        })
      })
    })
    .on('query', function () {
      ++trx1QueryCount
    }).catch(function (err) {
      t.equal(err, testError, 'Expected error reported')
      trx1Rejected = true
    })
    .finally(function () {
      // trx1: BEGIN, INSERT, ROLLBACK
      // trx2: SAVEPOINT, INSERT, ROLLBACK TO SAVEPOINT
      // trx3: SAVEPOINT INSERT, SELECT (this savepoint is implicitly rolledback and erased)
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedTrx1QueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      var expectedTrx2QueryCount = 3
      var expectedTrx3QueryCount = 3
      expectedTrx2QueryCount += expectedTrx3QueryCount;
      expectedTrx1QueryCount += expectedTrx2QueryCount
      t.equal(trx1QueryCount, expectedTrx1QueryCount, 'Expected number of outer transaction SQL queries executed')
      t.equal(trx2QueryCount, expectedTrx2QueryCount, 'Expected number of single-nested transaction SQL queries executed')
      t.equal(trx3QueryCount, expectedTrx3QueryCount, 'Expected number of double-nested transaction SQL queries executed')
      t.equal(trx1Rejected, true, 'Outer transaction promise rejected')
      return knex.select('*').from('test_table').then(function (results) {
        t.equal(results.length, 1, 'One row inserted')
      })
    })
  })

  test('doubly-nested and single-nested transaction both rollback on single-nested transaction returned caught rejected promise', function (t) {
    var testError = new Error('Rolling Back Savepoint')
    var trx1QueryCount = 0
    var trx2QueryCount = 0
    var trx3QueryCount = 0
    var trx2Rejected
    return knex.transaction(function (trx1) {
      return trx1.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        return trx1.transaction(function (trx2) {
          return trx2.table('test_table').insert({id: 2, name: 'B'}).then(function () {
            return trx2.transaction(function (trx3) {
              return trx3.table('test_table').insert({id: 3, name: 'C'}).then(function () {
                return trx3('test_table').then(function (results) {
                  t.equal(results.length, 3, 'Three rows inserted')
                })
              })
            })
            .on('query', function () {
              ++trx3QueryCount;
            }).then(function () {
              throw testError;
            });
          })
        })
        .on('query', function () {
          ++trx2QueryCount
        })
      }).catch(function (err) {
        t.equal(err, testError, 'Expected error reported')
        trx2Rejected = true
      })
    })
    .on('query', function () {
      ++trx1QueryCount
    })
    .finally(function () {
      // trx1: BEGIN, INSERT, ROLLBACK
      // trx2: SAVEPOINT, INSERT, ROLLBACK TO SAVEPOINT
      // trx3: SAVEPOINT, INSERT, SELECT
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedTrx1QueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      var expectedTrx2QueryCount = 3
      var expectedTrx3QueryCount = 3
      expectedTrx2QueryCount += expectedTrx3QueryCount;
      expectedTrx1QueryCount += expectedTrx2QueryCount
      t.equal(trx1QueryCount, expectedTrx1QueryCount, 'Expected number of parent transaction SQL queries executed')
      t.equal(trx2QueryCount, expectedTrx2QueryCount, 'Expected number of single-nested transaction SQL queries executed')
      t.equal(trx3QueryCount, expectedTrx3QueryCount, 'Expected number of double-nested transaction SQL queries executed')
      t.equal(trx2Rejected, true, 'Single-nested transaction promise rejected')
      return knex.select('*').from('test_table').then(function (results) {
        //TODO: assert deep equality between this row and A1
        t.equal(results.length, 1, 'One row inserted')
      })
    })
  })

  test('transaction savepoint rollback on error throw', function (t) {
    var testError = new Error('Rolling Back Savepoint')
    var trx1QueryCount = 0
    var trx2QueryCount = 0
    var trx2Rejected
    return knex.transaction(function (trx1) {
      return trx1.insert({id: 1, name: 'A'}).into('test_table').then(function () {
        // Nested transaction (savepoint)
        return trx1.transaction(function () {  // trx2
          // Roll back to savepoint
          throw testError
        })
        .on('query', function () {
          ++trx2QueryCount
        })
      }).catch(function (err) {
        t.equal(err, testError, 'Expected error reported')
        trx2Rejected = true
      })
    })
    .on('query', function () {
      ++trx1QueryCount
    })
    .finally(function () {
      // trx1: BEGIN, INSERT, ROLLBACK
      // trx2: SAVEPOINT, ROLLBACK TO SAVEPOINT
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedTrx1QueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      var expectedTrx2QueryCount = 2
      expectedTrx1QueryCount += expectedTrx2QueryCount
      t.equal(trx1QueryCount, expectedTrx1QueryCount, 'Expected number of parent transaction SQL queries executed')
      t.equal(trx2QueryCount, expectedTrx2QueryCount, 'Expected number of nested transaction SQL queries executed')
      t.equal(trx2Rejected, true, 'Nested transaction promise rejected')
      return knex.select('*').from('test_table').then(function (results) {
        t.equal(results.length, 1, 'One row inserted')
      })
    })
  })


  test('sibling nested transactions - second created after first one commits', function (t) {
    var secondTransactionCompleted = false
    return knex.transaction(function (trx) {
      return trx.transaction(function (trx1) {
        return trx1.insert({id: 1, name: 'A'}).into('test_table')
        .then(function () {
          return trx1.insert({id: 2, name: 'B'}).into('test_table')
        })
      })
      .then(function () {
        return trx.transaction(function (trx2) {
          return trx2('test_table').then(function (results) {
            secondTransactionCompleted = true
            t.equal(results.length, 2, 'First sibling transaction committed before starting the second one')
          })
        })
      })
    })
    .finally(function () {
      t.equal(secondTransactionCompleted, true, 'Second sibling transaction completed')
    })
  })

  test('sibling nested transactions - both chained sibling transactions committed', function (t) {
    return knex.transaction(function (trx) {
      return trx.transaction(function (trx1) {
        return trx1.insert({id: 1, name: 'A'}).into('test_table')
      })
      .then(function () {
        return trx.transaction(function (trx2) {
          return trx2.insert({id: 2, name: 'B'}).into('test_table')
        })
      })
    })
    .finally(function () {
      return knex('test_table').then(function (results) {
        t.equal(results.length, 2, 'Parent transaction inserted 2 records')
      })
    })
  })

  test('sibling nested transactions - second created after first one rolls back by returning a rejected promise', function (t) {
    var secondTransactionCompleted = false
    return knex.transaction(function (trx) {
      return trx.transaction(function (trx1) {
        return trx1.insert({id: 1, name: 'A'}).into('test_table')
        .then(function () {
          throw new Error('test rollback')
        })
      })
      .catch(function (err) {
        t.equal(err.message, 'test rollback', 'First sibling transaction rolled back before starting the second one')
        return trx.transaction(function (trx2) {
          return trx2('test_table').then(function () {
            secondTransactionCompleted = true
          })
        })
      })
    })
    .finally(function () {
      t.equal(secondTransactionCompleted, true, 'Second sibling transaction completed')
    })
  })

  test('sibling nested transactions - second commits data after first one rolls back by returning a rejected promise', function (t) {
    return knex.transaction(function (trx) {
      return trx.transaction(function (trx1) {
        return trx1.insert({id: 1, name: 'A'}).into('test_table')
        .then(function () {
          throw new Error('test rollback')
        })
      })
      .catch(function (err) {
        t.equal(err.message, 'test rollback', 'First sibling transaction rolled back before starting the second one')
        return trx.transaction(function (trx2) {
          return trx2.insert([{id: 2, name: 'B'}, {id: 3, name: 'C'}]).into('test_table')
        })
      })
    })
    .finally(function () {
      return knex('test_table').then(function (results) {
        t.equal(results.length, 2, 'Parent transaction inserted two records')
      })
    })
  })

  test('sibling nested transactions - second created after first one rolls back by throwing', function (t) {
    var secondTransactionCompleted = false
    return knex.transaction(function (trx) {
      return trx.transaction(function () {
        throw new Error('test rollback')
      })
      .catch(function (err) {
        t.equal(err.message, 'test rollback', 'First sibling transaction rolled back before starting the second one')
        return trx.transaction(function (trx2) {
          return trx2('test_table').then(function () {
            secondTransactionCompleted = true
          })
        })
      })
    })
    .finally(function () {
      t.equal(secondTransactionCompleted, true, 'Second sibling transaction completed')
    })
  })

  test('sibling nested transactions - second commits data after first one rolls back by throwing', function (t) {
    return knex.transaction(function (trx) {
      return trx.transaction(function () {
        throw new Error('test rollback')
      })
      .catch(function (err) {
        t.equal(err.message, 'test rollback', 'First sibling transaction rolled back before starting the second one')
        return trx.transaction(function (trx2) {
          return trx2.insert([{id: 1, name: 'A'}]).into('test_table')
        })
      })
    })
    .finally(function () {
      return knex('test_table').then(function (results) {
        t.equal(results.length, 1, 'Parent transaction inserted one record')
      })
    })
  })

  test('sibling nested transactions - first commits data even though second one rolls back by returning a rejected promise', function (t) {
    var secondTransactionCompleted = false
    return knex.transaction(function (trx) {
      return trx.transaction(function (trx1) {
        return trx1.insert({id: 1, name: 'A'}).into('test_table')
      })
      .then(function () {
        return trx.transaction(function (trx2) {
          return trx2.insert([{id: 2, name: 'B'}, {id: 3, name: 'C'}]).into('test_table')
          .then(function () {
            secondTransactionCompleted = true
            throw new Error('test rollback')
          })
        })
        .catch(function () {})
      })
    })
    .finally(function () {
      t.equal(secondTransactionCompleted, true, 'Second sibling transaction completed')
      return knex('test_table').then(function (results) {
        t.equal(results.length, 1, 'Parent transaction inserted one record')
      })
    })
  })

  test('sibling nested transactions - first commits data even though second one rolls back by throwing', function (t) {
    var secondTransactionCompleted = false
    return knex.transaction(function (trx) {
      return trx.transaction(function (trx1) {
        return trx1.insert({id: 1, name: 'A'}).into('test_table')
      })
      .then(function () {
        return trx.transaction(function () {
          secondTransactionCompleted = true
          throw new Error('test rollback')
        })
        .catch(function () {})
      })
    })
    .finally(function () {
      t.equal(secondTransactionCompleted, true, 'Second sibling transaction completed')
      return knex('test_table').then(function (results) {
        t.equal(results.length, 1, 'Parent transaction inserted one record')
      })
    })
  })

  test('#625 - streams/transactions', 'postgresql', function(t) {

    var cid, queryCount = 0;

    return knex.transaction(function(tx) {
      Promise.each([
        'SET join_collapse_limit to 1',
        'SET enable_nestloop = off'
      ], function(request) {
        return tx.raw(request)
      })
      .then(function() {
        var stream = tx.table('test_table').stream();
        stream.on('end', function () {
          tx.commit();
          t.equal(queryCount, 5, 'Five queries run')
        });
        stream.pipe(JSONStream.stringify());
      })
      .catch(tx.rollback)
    })
    .on('query', function(q) {
      if (!cid) {
        cid = q.__knexUid
      } else {
        if (cid !== q.__knexUid) {
          throw new Error('Invalid connection ID')
        }
      }
      queryCount++
    })

  })

  test('#785 - skipping extra transaction statements after commit / rollback', function(t) {

    var queryCount = 0

    return knex.transaction(function(trx) {
      knex('test_table')
        .transacting(trx)
        .insert({name: 'Inserted before rollback called.'})
        .then(function() {
          trx.rollback(new Error('Rolled back'));
        })
        .then(function() {
          return knex('test_table')
            .transacting(trx)
            .insert({name: 'Inserted after rollback called.'})
            .then(function(resp) {
              t.error(resp)
            })
            .catch(function() {})
        })
    })
    .on('query', function() {
      queryCount++
    })
    .catch(function(err) {
      t.equal(err.message, 'Rolled back', 'Transaction promise rejected with expected error')
    })
    .finally(function() {
      // oracle & mssql: BEGIN & ROLLBACK not reported as queries
      var expectedQueryCount =
        knex.client.dialect === 'oracle' ||
        knex.client.dialect === 'mssql' ? 1 : 3
      t.equal(queryCount, expectedQueryCount, 'Expected number of transaction SQL queries executed')
    })

  })

  test('#805 - nested ddl transaction', function() {
    return knex.transaction(function(knex) {
      return knex.transaction(function(trx) {
        return trx.schema.createTable('ages', function(t) {
          t.increments('id').primary();
          t.string('name').unique().notNull();
        });
      })
    })
    .finally(function() {
      return knex.schema.dropTableIfExists('ages')
    });
  });

  if (knex.client.driverName === 'pg') {
    tape('allows postgres ? operator in knex.raw() if no bindings given #519 and #888', function (t) {
      knex.from('test_table_two')
        .whereRaw("(json_data->'me')::jsonb \\?& array['keyOne', 'keyTwo']")
        .where('id', '>', 1)
        .then(function (result) {
          t.equal(result.length, 0, "Table should have been empty")
          return result
        })
        .finally(function () {
          t.end()
        });
    })
  }
}
