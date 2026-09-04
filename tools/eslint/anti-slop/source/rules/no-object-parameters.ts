import { defineRule } from "../eslint-compat.ts";

import type { ESTree, SourceCode } from "../eslint-compat.ts";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type Parameter = ESTree.Parameter;
type ParameterOwner =
	| ESTree.ArrowFunctionExpression
	| ESTree.FunctionDeclaration
  | ESTree.FunctionExpression
  | ESTree.TSDeclareFunction
  | ESTree.TSEmptyBodyFunctionExpression
	| ESTree.TSCallSignatureDeclaration
	| ESTree.TSConstructSignatureDeclaration
	| ESTree.TSConstructorType
	| ESTree.TSFunctionType
	| ESTree.TSMethodSignature;

type RuntimeFunction =
	| ESTree.ArrowFunctionExpression
	| ESTree.FunctionDeclaration
	| ESTree.FunctionExpression;

function isRuntimeFunction(node: ParameterOwner): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isValidationFunction(node: ParameterOwner): boolean {
	if (isRuntimeFunction(node) && node.returnType?.typeAnnotation.type === "TSTypePredicate") return true;
	if (!isRuntimeFunction(node)) return false;
	const name =
		node.id?.name ??
		(node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
			? node.parent.id.name
			: null);
	return name !== null && /^(?:is|has|assert|parse|read|validate|normalize|decode|deserialize|coerce|sanitize|scrub|strip|unwrap|extract)[A-Z0-9_]/u.test(name);
}

function parameterIsUnused(parameter: Parameter, sourceCode: SourceCode): boolean {
	const identifier =
		parameter.type === "Identifier"
			? parameter
			: parameter.type === "AssignmentPattern" && parameter.left.type === "Identifier"
				? parameter.left
				: parameter.type === "RestElement" && parameter.argument.type === "Identifier"
					? parameter.argument
					: null;
	if (identifier === null) return false;
	const variable = sourceCode.getScope(identifier).set.get(identifier.name);
	return variable !== undefined && variable.references.length === 0;
}

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") {
		return parameterAnnotation(parameter.parameter);
	}
	if (parameter.type === "RestElement") {
		if (parameter.argument.type === "MemberExpression") throw new Error("A function rest parameter cannot target a member expression");
		return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
	}
	return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceCode: SourceCode): string {
	return parameter.type === "Identifier"
		? parameter.name
		: sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
		},
		messages: {
			objectParameter:
				"Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
		},
	},
	createOnce(context) {
		const aliases = new Map<string, ESTree.TypeNode>();

		const resolvesToObject = (
			type: ESTree.TypeNode,
			shadowedAliases: ReadonlySet<string>,
			visited = new Set<string>(),
		): boolean => {
			if (type.type === "TSObjectKeyword") return true;

			if (type.type === "TSUnionType") {
				return type.types.some((member) =>
					resolvesToObject(member, shadowedAliases, visited),
				);
			}
			if (
				type.type !== "TSTypeReference" ||
				type.typeName.type !== "Identifier" ||
				(type.typeArguments !== null &&
					type.typeArguments !== undefined &&
					type.typeArguments.params.length > 0) ||
				visited.has(type.typeName.name) ||
				shadowedAliases.has(type.typeName.name)
			) {
				return false;
			}
			const alias = aliases.get(type.typeName.name);
			if (alias === undefined) return false;
			const nextVisited = new Set(visited);
			nextVisited.add(type.typeName.name);
			return resolvesToObject(alias, shadowedAliases, nextVisited);
		};

		const checkParameters = (node: ParameterOwner) => {
			if (isValidationFunction(node)) return;
			const shadowedAliases = lexicalTypeParameterNames(
				node,
				context.sourceCode.visitorKeys,
			);
			for (const parameter of node.params) {
				if (parameterIsUnused(parameter, context.sourceCode)) continue;
				const annotation = parameterAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				if (!resolvesToObject(annotation.typeAnnotation, shadowedAliases)) continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "objectParameter",
					data: { parameter: parameterName(parameter, context.sourceCode) },
				});
			}
		};

		return {
			Program(node) {
				aliases.clear();
				for (const statement of node.body) {
					const declaration =
						statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
					if (
						declaration?.type === "TSTypeAliasDeclaration" &&
						(declaration.typeParameters === null || declaration.typeParameters === undefined)
					) {
						aliases.set(declaration.id.name, declaration.typeAnnotation);
					}
				}
			},
			ArrowFunctionExpression: checkParameters,
			FunctionDeclaration: checkParameters,
			FunctionExpression: checkParameters,
			TSCallSignatureDeclaration: checkParameters,
			TSConstructSignatureDeclaration: checkParameters,
			TSConstructorType: checkParameters,
			TSDeclareFunction: checkParameters,
			TSEmptyBodyFunctionExpression: checkParameters,
			TSFunctionType: checkParameters,
			TSMethodSignature: checkParameters,
		};
	},
});
