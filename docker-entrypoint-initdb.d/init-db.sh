#!/bin/bash
set -e

clickhouse client -n <<-EOSQL
    CREATE DATABASE test;
    CREATE TABLE test.company_metrics (
        company_id Int32,
        date Date,
        mrr Int32
    ) ENGINE = MergeTree()
    ORDER BY (company_id, date);
EOSQL