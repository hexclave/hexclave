import { defineRule } from "../eslint-compat.ts";
import type { ESTree, SourceCode } from "../eslint-compat.ts";
import { isGeneratedSdkSource, isTestFilename } from "../shared/file-scope.ts";

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

function isTypeGuard(node: ParameterOwner): boolean {
  return node.returnType?.typeAnnotation.type === "TSTypePredicate";
}

function isValidationFunction(node: ParameterOwner): boolean {
	if (isTypeGuard(node)) return true;
	if (!isRuntimeFunction(node)) return false;
  const name =
    node.id?.name ??
    (node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
      ? node.parent.id.name
      : null);
	return name !== null && /^(?:is|has|assert|parse|read|validate|normalize|decode|deserialize|coerce|sanitize|scrub|strip|unwrap|extract|yup)(?:[A-Z0-9_]|$)/u.test(name);
}

function isUnknownErrorParameter(name: string): boolean {
  return /^(?:error|err|reason|exception|cause|e)$/u.test(name);
}

/**
 * Unknown is useful while adapting a value inside a function, but it should
 * not leak through a public callable contract. Nested callbacks are checked
 * by the function that owns the boundary; requiring every callback to repeat
 * the boundary type creates noise and encourages casts instead of parsing.
 */
function isPublicCallable(node: ParameterOwner): boolean {
  if (
    node.type === "TSCallSignatureDeclaration" ||
    node.type === "TSConstructSignatureDeclaration" ||
    node.type === "TSConstructorType" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression" ||
    node.type === "TSFunctionType" ||
    node.type === "TSMethodSignature"
  ) return true;

  if (node.type === "FunctionDeclaration") {
    return node.parent.type === "Program" || node.parent.type === "ExportNamedDeclaration" || node.parent.type === "ExportDefaultDeclaration";
  }

  if (node.parent.type !== "VariableDeclarator") return false;
  const declaration = node.parent.parent;
  if (declaration.type !== "VariableDeclaration") return false;
  return declaration.parent.type === "Program" || declaration.parent.type === "ExportNamedDeclaration";
}

function parameterIsUnused(
  parameter: Parameter,
  sourceCode: SourceCode,
): boolean {
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

function hasRuntimeValidation(
	parameter: Parameter,
	sourceCode: SourceCode,
): boolean {
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
	if (variable === undefined) return false;
	return variable.references.some((reference) => {
		let current: ESTree.Node | null = reference.identifier;
		while (current !== null && current.type !== "Program") {
			if (current.type === "UnaryExpression" && current.operator === "typeof") return true;
			if (
				current.type === "BinaryExpression" &&
				(current.operator === "in" || current.operator === "instanceof")
			) return true;
			if (
				current.type === "CallExpression" &&
				current.callee.type === "MemberExpression" &&
				!current.callee.computed &&
				current.callee.object.type === "Identifier" &&
				current.callee.object.name === "Array" &&
				current.callee.property.type === "Identifier" &&
				(current.callee.property.name === "isArray" || current.callee.property.name === "isArrayBuffer")
			) return true;
			if (
				current.type === "CallExpression" &&
				current.callee.type === "MemberExpression" &&
				!current.callee.computed &&
				current.callee.object.type === "Identifier" &&
				current.callee.object.name === "JSON" &&
				current.callee.property.type === "Identifier" &&
				current.callee.property.name === "stringify"
			) return true;
			if (
				current.type === "CallExpression" &&
				current.callee.type === "Identifier" &&
				/^(?:is|has|assert|validate|parse|read|decode|normalize|coerce|sanitize|scrub|strip|unwrap|extract|yup)(?:[A-Z0-9_]|$)/u.test(current.callee.name)
			) return true;
			current = current.parent ?? null;
		}
		return false;
	});
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

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    if (parameter.argument.type === "MemberExpression") throw new Error("A function rest parameter cannot target a member expression");
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
	createOnce(context) {
		if (isTestFilename(context.getFilename()) || isGeneratedSdkSource(context.sourceCode.text)) return {};
		const checkParameters = (node: ParameterOwner) => {
			if (isValidationFunction(node)) return;
			for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        if (!isPublicCallable(node)) continue;
        if (hasRuntimeValidation(parameter, context.sourceCode)) continue;
        const name = parameterName(parameter, context.sourceCode.getText(parameter));
        if (
          name === "cause" ||
          isUnknownErrorParameter(name) ||
          (isRuntimeFunction(node) && parameterIsUnused(parameter, context.sourceCode))
        ) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
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
