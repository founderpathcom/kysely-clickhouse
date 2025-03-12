import type { CompiledQuery, DatabaseConnection, QueryResult } from "kysely";

import { createClient } from "@clickhouse/client";
import type { ClickhouseDialectConfig } from ".";
import type { NodeClickHouseClient } from "@clickhouse/client/dist/client";

export class ClickhouseConnection implements DatabaseConnection {
	#client: NodeClickHouseClient;

	constructor(config: ClickhouseDialectConfig) {
		this.#client = createClient({
			...config.options,
			clickhouse_settings: {
				...config.options?.clickhouse_settings,
				date_time_input_format: "best_effort",
			},
		});
	}

	private detectClickhouseType(param: unknown): string {
		if (Array.isArray(param)) {
			return `Array(${this.detectClickhouseType(param[0])})`;
		}
		if (param instanceof Date) {
			return "DateTime";
		}
		if (typeof param === "number") {
			return "Double Precision";
		}
		return "String";
	}

	prepareQuery<O>(compiledQuery: CompiledQuery) {
		let i = -1;
		const compiledSql = compiledQuery.sql.replace(/\?/g, () => {
			i = i + 1;
			const param = compiledQuery.parameters[i];
			return `{ param_${i}: ${this.detectClickhouseType(param)}}`;
		});

		const queryParamEntries = compiledQuery.parameters.map((it, index) => {
			const key = `param_${index}`;
			if (it instanceof Date) {
				return [key, it.toJSON()];
			}
			return [key, it];
		});

		return {
			sql: compiledSql,
			query_params: Object.fromEntries(queryParamEntries),
		};
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		if (compiledQuery.query.kind === "InsertQueryNode") {
			const values = [
				compiledQuery.query.columns?.map((c) => c.column.name) ?? [],
				// @ts-expect-error: fix types
				...(compiledQuery.query.values?.values.map((v) => v.values) ?? []),
			];

			const schema = compiledQuery.query.into?.table?.schema?.name;
			const table = compiledQuery.query.into?.table.identifier.name ?? "";
			const fullQualifiedTable = schema ? `${schema}.${table}` : table;
			const resultSet = await this.#client.insert({
				table: fullQualifiedTable,
				format: "JSONCompactEachRowWithNames",
				values,
				clickhouse_settings: {
					date_time_input_format: "best_effort",
				},
			});

			return {
				rows: [],
				numAffectedRows: BigInt(resultSet.summary?.written_rows ?? 0),
				numChangedRows: BigInt(resultSet.summary?.written_rows ?? 0),
			};
		}

		if (
			compiledQuery.query.kind === "UpdateQueryNode" ||
			compiledQuery.query.kind === "SelectQueryNode"
		) {
			const query = this.prepareQuery(compiledQuery);

			const resultSet = await this.#client.query({
				query: query.sql,
				query_params: query.query_params,
			});
			const response = await resultSet.json();

			return {
				rows: response.data as O[],
			};
		}

		const query = this.prepareQuery(compiledQuery);
		await this.#client.command({
			query: query.sql,
			query_params: query.query_params,
			clickhouse_settings: {
				wait_end_of_query: 1,
			},
		});

		return {
			rows: [],
		};
	}

	async beginTransaction() {
		throw new Error("Transactions are not supported.");
	}

	async commitTransaction() {
		throw new Error("Transactions are not supported.");
	}

	async rollbackTransaction() {
		throw new Error("Transactions are not supported.");
	}

	async *streamQuery<O>(
		compiledQuery: CompiledQuery,
		chunkSize: number,
	): AsyncIterableIterator<QueryResult<O>> {
		const query = this.prepareQuery(compiledQuery);

		const resultSet = await this.#client.query({
			query: query.sql,
			query_params: query.query_params,
			format: "JSONEachRow",
		});

		const stream = resultSet.stream();

		for await (const row of stream) {
			yield {
				rows: [row as O],
			};
		}
	}
}
