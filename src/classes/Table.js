import Upload from './Upload.js';
import Variable from './Variable.js';
import { makeRequest, makePaginatedRequest, makeRowsRequest } from '../common/apiRequest.js';

// TODO: handle periods in name (properly escape) — and for all other entities
export default class Table {
	constructor(argName, options = {}) {
		if (typeof argName === 'object') {
			options = argName;
			argName = undefined;
		}
		const { name = argName, sample = false, dataset, project, properties } = options;
		const parent = dataset || project;
		const owner = parent.organization || parent.user;
		const sampleString = sample ? ':sample' : '';
		const versionString = dataset ? `:${dataset.version}` : '';
		this.hasPopulatedProperties = false;
		this.name = name;
		this.dataset = dataset;
		this.project = project;
		this.identifier = `${owner.name}.${parent.name}:${versionString}.${this.name}${sampleString}`;
		this.uri = `/tables/${encodeURIComponent(this.identifier)}`;
		this.properties = { name, identifier: this.identifier, uri: this.uri, dataset, project, ...properties };
	}

	// TODO: validate properties usage
	getProperty(prop) {
		return this.properties?.[prop];
	}

	toString() {
		return JSON.stringify(this.properties, null, 2);
	}

	variable(name) {
		return new Variable(name, { table: this });
	}

	async exists() {
		try {
			await makeRequest({ method: 'GET', path: this.uri });
		} catch (e) {
			if (e.status !== 404) {
				throw e;
			}
			return false;
		}
		return true;
	}

	async get() {
		this.properties = await makeRequest({ method: 'GET', path: this.uri });
		this.uri = this.properties.uri;
		this.hasPopulatedProperties = true;
		return this;
	}

	async listVariables({ maxResults } = {}) {
		let variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		variables = variables.map((variable) => new Variable({ ...variable, table: this }));
		if (maxResults === undefined || variables.length < maxResults) {
			this.variables = variables;
		}
		return variables;
	}

	async listRows(limit) {
		if (!this.variables) {
			this.variables = await this.listVariables({ maxResults: 10000 });
		}
		if (!this.hasPopulatedProperties) {
			await this.get();
		}
		const maxResults = limit === undefined ? this.properties.numRows : Math.min(limit, this.properties.numRows);
		const rows = await makeRowsRequest({
			uri: this.uri,
			maxResults,
			query: { selectedVariables: this.variables.map((variable) => variable.properties.name).join(',') },
		});
		return rows.map((row) => {
			const rowObject = {};
			for (let i = 0; i < row.length; i++) {
				if (row[i] === null) {
					rowObject[this.variables[i].name] = row[i];
				} else {
					switch (this.variables[i].type) {
						case 'integer':
							rowObject[this.variables[i].name] = parseInt(row[i]);
							break;
						case 'float':
							rowObject[this.variables[i].name] = parseFloat(row[i]);
							break;
						case 'date':
							rowObject[this.variables[i].name] = new Date(`${row[i]}T00:00:00Z`);
							break;
						case 'dateTime':
							rowObject[this.variables[i].name] = new Date(`${row[i]}Z`);
							break;
						default:
							rowObject[this.variables[i].name] = row[i];
					}
				}
			}
			return rowObject;
		});
	}

	async download() {
		// TODO
	}
}
// TODO
// class Table:

//     def create(self, *, description=None, upload_merge_strategy="append"):
//         response = make_request(
//             method="POST",
//             path=f"{self.dataset.uri}/tables",
//             payload={
//                 "name": self.name,
//                 "description": description,
//                 "uploadMergeStrategy": upload_merge_strategy,
//             },
//         )
//         self.properties = response
//         self.uri = self.properties["uri"]
//         return self

//     def update(self, *, name=None, description=None, upload_merge_strategy=None):
//         payload = {}
//         if name:
//             payload["name"] = name
//         if upload_merge_strategy:
//             payload["mergeStrategy"] = upload_merge_strategy
//         if description is not None:
//             payload["description"] = description

//         response = make_request(
//             method="PATCH",
//             path=f"{self.uri}",
//             payload=payload,
//         )
//         self.properties = response
//         return

//     def delete(self):
//         make_request(
//             method="DELETE",
//             path=self.uri,
//         )
//         return

//     def upload(self, *, name, data, type, remove_on_fail=True):
//         response = make_request(
//             method="POST",
//             path=f"{self.uri}/uploads",
//             payload={"name": name, "type": type},
//         )
//         upload = Upload(uri=response["uri"])
//         try:
//             upload.upload_file(data)
//             while True:
//                 time.sleep(2)
//                 upload.get()
//                 if upload["status"] == "completed":
//                     break
//                 elif upload["status"] == "failed":
//                     raise Exception(upload["errorMessage"])
//                 else:
//                     logging.debug("Upload is still in progress...")
//         except Exception as e:
//             if remove_on_fail:
//                 print("An error occurred. Deleting upload.")
//                 upload.delete()
//             raise e

//         return upload

//     def list_uploads(self, *, max_results=None):
//         uploads = make_paginated_request(
//             path=f"{self.uri}/uploads", max_results=max_results
//         )
//         return [Upload(upload) for upload in uploads]
