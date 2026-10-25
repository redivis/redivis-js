export class RedivisError extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = new.target.name;
	}
}

// An error response from the Redivis API. `code` is the machine-readable error (e.g. "not_found"), and
//   `description` the human-readable explanation.
export class APIError extends RedivisError {
	constructor({ status, code = 'api_error', description } = {}) {
		super(description ? `[${status} ${code}] ${description}` : `[${status} ${code}]`);
		this.status = status;
		this.code = code;
		this.description = description;
	}
}

export class NotFoundError extends APIError {
	constructor({ status = 404, code = 'not_found', description } = {}) {
		super({ status, code, description });
		this.message = description || code;
	}
}

export class AuthorizationError extends APIError {
	constructor({ status = 403, code = 'forbidden', description } = {}) {
		super({ status, code, description });
	}
}

// A request couldn't complete, even after retrying. The underlying error is available as `cause`.
export class NetworkError extends RedivisError {
	constructor(message = 'A network error occurred', { cause } = {}) {
		super(cause?.message ? `${message}: ${cause.message}` : message, { cause });
	}
}

// A job (query, upload, export, transform, etc.) finished without succeeding
export class JobError extends RedivisError {
	constructor({ message, kind, status = 'status unknown' } = {}) {
		message = message || `Job finished with status: ${status}`;
		super(kind ? `[${kind} ${status}] ${message}` : message);
		this.kind = kind;
		this.status = status;
	}
}

// Invalid arguments, or an operation that isn't valid in the current state or environment
export class ValueError extends RedivisError {}

// Maps a failed API response's parsed body onto the matching error class. Auth errors are flat
//   ({ error, error_description }), while some other API errors nest them ({ error: { message } }).
export function createApiError(status, body) {
	let code;
	let description;
	if (body && typeof body === 'object') {
		const { error, error_description } = body;
		code = typeof error === 'string' ? error : error?.code || error?.status;
		description = error_description || error?.message;
	} else if (body) {
		description = String(body);
	}
	code = code || 'api_error';

	if (status === 404) {
		return new NotFoundError({ status, code, description });
	} else if (status === 403) {
		return new AuthorizationError({ status, code, description });
	}
	return new APIError({ status, code, description });
}
