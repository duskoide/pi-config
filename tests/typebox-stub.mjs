const optional = Symbol("optional");
export const Type = {
	String: (options = {}) => ({ type: "string", ...options }),
	Boolean: (options = {}) => ({ type: "boolean", ...options }),
	Literal: (value) => ({ const: value, type: typeof value }),
	Never: () => ({ not: {} }),
	Union: (schemas) => ({ anyOf: schemas }),
	Optional: (schema) => ({ ...schema, [optional]: true }),
	Object: (properties, options = {}) => ({
		type: "object", properties,
		required: Object.entries(properties).filter(([, schema]) => !schema[optional]).map(([key]) => key),
		...options,
	}),
};
