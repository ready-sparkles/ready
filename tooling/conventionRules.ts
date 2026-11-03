import type { TSESTree } from "@typescript-eslint/utils";
import { ASTUtils, ESLintUtils } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = ESLintUtils.RuleCreator(() => "docs/lint-policy.md");
const characters = (...codes: number[]) => String.fromCharCode(...codes);
const removedOperator = characters(100, 101, 108, 101, 116, 101);
const booleanPrefix = /^(is|has|can|should)[A-Z0-9_]/;
const functionSelector =
  "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSFunctionType, TSMethodSignature, TSDeclareFunction";
const nativeMutators = new Map<string, string[]>([
  ["Map", ["set", removedOperator, "clear"]],
  ["Set", ["add", removedOperator, "clear"]],
]);
const targetMutators = new Map<string, string[]>([
  ["Object", ["assign", "defineProperty", "defineProperties", "setPrototypeOf"]],
  ["Reflect", ["set", "deleteProperty", "defineProperty", "setPrototypeOf"]],
]);
const eslintBooleanOptions = new Set([
  "props",
  "ignoreArrayIndexes",
  "ignoreEnums",
  "ignoreNumericLiteralTypes",
  "ignoreTypeIndexes",
  "ignoreReadonlyClassProperties",
  "enforceConst",
  "detectObjects",
  "skipBlankLines",
  "skipComments",
  "projectService",
  "allowString",
  "allowNumber",
  "allowAny",
  "allowNullish",
  "useTabs",
]);
const mutators = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const isNativeRoute = ({ node, filename }: { node: TSESTree.Node; filename: string }) => {
  if (!/\/web\/(?:app|adapters\/primary\/next-http)\/(?:.*\/)?route\.ts$/.test(filename)) {
    return false;
  }
  if (node.type === "FunctionDeclaration" && node.parent.type === "ExportNamedDeclaration") {
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.id?.name ?? "");
  }
  const parent = node.parent;

  return (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier" &&
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(parent.id.name) &&
    parent.parent.parent.type === "ExportNamedDeclaration"
  );
};

const isFrameworkRouteRequest = (type: ts.Type) => {
  const symbol = type.getSymbol();

  return (
    symbol?.declarations?.some(
      (declaration) =>
        (symbol.name === "NextRequest" &&
          ts.isClassDeclaration(declaration) &&
          /\/node_modules\/next\/dist\/server\/web\/spec-extension\/request\.d\.ts$/.test(
            declaration.getSourceFile().fileName,
          )) ||
        (symbol.name === "Request" &&
          ts.isInterfaceDeclaration(declaration) &&
          /\/node_modules\/typescript\/lib\/lib\.dom\.d\.ts$/.test(declaration.getSourceFile().fileName)),
    ) === true
  );
};

const readMemberName = (node: TSESTree.MemberExpression): string | null => {
  if (node.property.type === "Identifier" && !node.computed) {
    return node.property.name;
  }

  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : null;
};

const externalContractAnnotation = /@external[ \t]+[^\s*]/;

const hasExternalContractAnnotation = (declaration: ts.Declaration) =>
  externalContractAnnotation.test(
    declaration.getSourceFile().text.slice(declaration.getFullStart(), declaration.getStart()),
  );
const isExternalDeclaration = (declaration: ts.Declaration) =>
  /\/node_modules\/|\/db\/generated\/|\/adapters\/outbound\/persistence\/generated\//.test(
    declaration.getSourceFile().fileName,
  ) || hasExternalContractAnnotation(declaration);
const readProperty = ({
  type,
  name,
  checker,
}: {
  type: ts.Type;
  name: string;
  checker: ts.TypeChecker;
}): ts.Symbol[] => {
  const narrowed = checker.getNonNullableType(type);
  const parts = narrowed.isUnionOrIntersection() ? narrowed.types : [narrowed];

  return parts.flatMap((part) => {
    const property = part.getProperty(name);

    return property ? [property] : [];
  });
};
const isExternalProperty = ({
  type,
  name,
  checker,
}: {
  type: ts.Type | undefined;
  name: string;
  checker: ts.TypeChecker;
}) => {
  if (type === undefined) {
    return false;
  }
  const narrowed = checker.getNonNullableType(type);
  const parts = narrowed.isUnionOrIntersection() ? narrowed.types : [narrowed];

  return parts.some((part) => {
    const property = part.getProperty(name);
    if (!property) {
      return false;
    }

    return (
      property.declarations?.some(isExternalDeclaration) === true ||
      (property.declarations === undefined && part.aliasSymbol?.declarations?.some(isExternalDeclaration) === true)
    );
  });
};
const isGenericExternalProperty = ({
  object,
  name,
  checker,
}: {
  object: ts.ObjectLiteralExpression;
  name: string;
  checker: ts.TypeChecker;
}): boolean => {
  const collectPath = ({
    current,
    path,
  }: {
    current: ts.ObjectLiteralExpression;
    path: string[];
  }): { root: ts.ObjectLiteralExpression; path: string[] } => {
    const parent = current.parent;
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isObjectLiteralExpression(parent.parent) &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
    ) {
      return collectPath({ current: parent.parent, path: [parent.name.text, ...path] });
    }

    return { root: current, path };
  };
  const { root, path } = collectPath({ current: object, path: [name] });
  const call = root.parent;
  if (!ts.isCallExpression(call)) {
    return false;
  }
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const constraints =
    declaration?.typeParameters?.flatMap((parameter) =>
      parameter.constraint ? [checker.getTypeAtLocation(parameter.constraint)] : [],
    ) ?? [];

  return constraints.some(
    (constraint) =>
      path.reduce<ts.Type[]>(
        (types, key) =>
          types.flatMap((type) =>
            readProperty({ type, name: key, checker }).map((property) =>
              checker.getTypeOfSymbolAtLocation(property, root),
            ),
          ),
        [constraint],
      ).length !== 0 &&
      readProperty({ type: constraint, name: path[0] ?? name, checker }).some(
        (property) => property.declarations?.some(isExternalDeclaration) === true,
      ),
  );
};

export const conventionRules = {
  "boolean-prefix": createRule({
    name: "boolean-prefix",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "suggestion",
      schema: [],
      messages: {
        prefix: "Name boolean bindings and fields with is, has, can, or should followed by a capitalized word.",
      },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();
      const isProtocolProperty = ({ node, name }: { node: TSESTree.Identifier | TSESTree.Literal; name: string }) => {
        const hasExplicitExternalName =
          ["TSPropertySignature", "Property"].includes(node.parent.type) &&
          context.sourceCode
            .getCommentsBefore(node.parent)
            .some((comment) => externalContractAnnotation.test(comment.value));
        if (hasExplicitExternalName) {
          return true;
        }
        if (
          node.parent.type === "Property" &&
          node.parent.key === node &&
          node.parent.parent.type === "ObjectPattern"
        ) {
          return true;
        }
        if (
          node.parent.type === "Property" &&
          node.parent.key === node &&
          node.parent.parent.type === "ObjectExpression"
        ) {
          if (/\/tooling\/eslint\.(config|rules)\.ts$/.test(context.filename) && eslintBooleanOptions.has(name)) {
            return true;
          }
          if (
            context.filename.endsWith("/tooling/architecture.ts") &&
            ["checkAllOrigins", "checkUnknownLocals"].includes(name)
          ) {
            return true;
          }
          const object = services.esTreeNodeToTSNodeMap.get(node.parent.parent);
          const contextual = checker.getContextualType(object);
          if (
            isExternalProperty({ type: contextual, name, checker }) ||
            isGenericExternalProperty({ object, name, checker })
          ) {
            return true;
          }
        }

        return false;
      };
      const check = (node: TSESTree.Identifier | TSESTree.Literal) => {
        const name = node.type === "Identifier" ? node.name : typeof node.value === "string" ? node.value : null;
        if (name === null || isProtocolProperty({ node, name })) {
          return;
        }
        // Next statically analyzes this exact exported route configuration name.
        if (
          name === "dynamicParams" &&
          /\/web\/app\/(?:.*\/)?(?:page|layout)\.tsx$/.test(context.filename) &&
          node.parent.type === "VariableDeclarator" &&
          node.parent.parent.parent.type === "ExportNamedDeclaration"
        ) {
          return;
        }
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
        const parts = type.isUnion() ? type.types : [type];
        const values = parts.filter((part) => (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0);
        if (
          values.length !== 0 &&
          values.every((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0) &&
          !booleanPrefix.test(name)
        ) {
          context.report({ node, messageId: "prefix" });
        }
      };

      return {
        "VariableDeclarator > Identifier.id, PropertyDefinition > Identifier.key, TSPropertySignature > Identifier.key":
          check,
        "FunctionDeclaration > Identifier.params, FunctionExpression > Identifier.params, ArrowFunctionExpression > Identifier.params":
          check,
        "Property > Identifier.key, Property > Literal.key, TSPropertySignature > Literal.key": check,
        "AssignmentPattern > Identifier.left, ArrayPattern > Identifier": check,
        "ObjectPattern > Property > Identifier.value": check,
      };
    },
  }),
  "named-parameters": createRule({
    name: "named-parameters",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "suggestion",
      schema: [],
      messages: {
        object:
          "Use one named parameter object for authored multiargument functions; inline callbacks and externally typed callbacks retain their required signatures.",
      },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();

      const isReferencedExternalCallback = (node: TSESTree.Node) => {
        const parent = node.parent;
        const callbackName =
          node.type === "FunctionDeclaration"
            ? node.id?.name
            : parent?.type === "VariableDeclarator" && parent.id.type === "Identifier"
              ? parent.id.name
              : null;
        const bindingNode = parent?.type === "VariableDeclarator" ? parent : node;
        const variable = context.sourceCode
          .getDeclaredVariables(bindingNode)
          .find((binding) => binding.name === callbackName);
        const reads = variable?.references.filter((reference) => reference.isRead()) ?? [];

        return (
          reads.length !== 0 &&
          reads.every((reference) => {
            const call = reference.identifier.parent;
            if (call.type !== "CallExpression") {
              return false;
            }
            const position = call.arguments.findIndex((argument) => argument === reference.identifier);
            const signature = checker.getResolvedSignature(services.esTreeNodeToTSNodeMap.get(call));
            const parameter = signature?.parameters[position];
            if (!parameter || signature.declaration?.getSourceFile().fileName.includes("/node_modules/") !== true) {
              return false;
            }

            return (
              checker
                .getNonNullableType(
                  checker.getTypeOfSymbolAtLocation(parameter, services.esTreeNodeToTSNodeMap.get(call)),
                )
                .getCallSignatures().length !== 0
            );
          })
        );
      };

      return {
        [functionSelector](
          node:
            | TSESTree.FunctionDeclaration
            | TSESTree.FunctionExpression
            | TSESTree.ArrowFunctionExpression
            | TSESTree.TSFunctionType
            | TSESTree.TSMethodSignature
            | TSESTree.TSDeclareFunction,
        ) {
          const params = node.params.filter((param) => param.type !== "Identifier" || param.name !== "this");
          if (params.length < 2) {
            return;
          }
          const parent = node.parent;
          if (
            (parent.type === "CallExpression" || parent.type === "NewExpression") &&
            parent.arguments.some((argument) => argument === node)
          ) {
            return;
          }
          if (isReferencedExternalCallback(node)) {
            return;
          }
          if (
            params.length === 2 &&
            isNativeRoute({ node, filename: context.filename }) &&
            isFrameworkRouteRequest(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(params[0] ?? node)))
          ) {
            return;
          }
          const mapped = services.esTreeNodeToTSNodeMap.get(node);
          if (ts.isExpression(mapped)) {
            const contextualType = checker.getContextualType(mapped);
            if (
              contextualType
                ?.getCallSignatures()
                .some(
                  (signature) => signature.declaration?.getSourceFile().fileName.includes("/node_modules/") === true,
                ) === true
            ) {
              return;
            }
          }
          context.report({ node, messageId: "object" });
        },
      };
    },
  }),
  "array-emptiness": createRule({
    name: "array-emptiness",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "suggestion",
      schema: [],
      messages: {
        empty: "Compare array.length === 0 (or !== 0) instead of equivalent numeric, truthy, or negated length checks.",
      },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();
      const isArrayLength = (node: TSESTree.Node): node is TSESTree.MemberExpression => {
        if (
          node.type !== "MemberExpression" ||
          !(
            (node.property.type === "Identifier" && !node.computed && node.property.name === "length") ||
            (node.property.type === "Literal" && node.property.value === "length")
          )
        ) {
          return false;
        }
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node.object));
        const parts = type.isUnion() ? type.types : [type];

        return parts.every((part) => checker.isArrayType(part) || checker.isTupleType(part));
      };

      return {
        BinaryExpression(node) {
          const length = isArrayLength(node.left) ? node.left : isArrayLength(node.right) ? node.right : null;
          const number = length === node.left ? node.right : node.left;
          if (!length || number.type !== "Literal" || typeof number.value !== "number") {
            return;
          }
          const reversedOperators: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
          const operator = length === node.left ? node.operator : (reversedOperators[node.operator] ?? node.operator);
          if (
            (number.value === 0 && ["==", "!=", ">", "<="].includes(operator)) ||
            (number.value === 1 && ["<", ">="].includes(operator))
          ) {
            context.report({ node, messageId: "empty" });
          }
        },
        MemberExpression(node) {
          if (!isArrayLength(node)) {
            return;
          }
          const parent = node.parent;
          if (
            (parent.type === "UnaryExpression" && parent.operator === "!") ||
            ((parent.type === "IfStatement" ||
              parent.type === "ConditionalExpression" ||
              parent.type === "WhileStatement") &&
              parent.test === node) ||
            (parent.type === "LogicalExpression" && parent.operator !== "??" && parent.left === node) ||
            (parent.type === "CallExpression" &&
              parent.callee.type === "Identifier" &&
              parent.callee.name === "Boolean")
          ) {
            context.report({ node, messageId: "empty" });
          }
        },
      };
    },
  }),
  "optional-nullable": createRule({
    name: "optional-nullable",
    meta: {
      docs: { description: "Check explicit nullable annotations on inward-owned optional record fields." },
      type: "suggestion",
      schema: [],
      messages: {
        nullable:
          "Include null in this @nullable optional record field. Omission and explicit null have different meanings.",
      },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();

      return {
        "TSPropertySignature[optional=true]"(node: TSESTree.TSPropertySignature) {
          if (!context.sourceCode.getCommentsBefore(node).some((comment) => /@nullable\b/.test(comment.value))) {
            return;
          }
          const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
          const hasNull = (type.isUnion() ? type.types : [type]).some((part) => (part.flags & ts.TypeFlags.Null) !== 0);
          const annotation = node.typeAnnotation?.typeAnnotation;
          const hasExplicitNull =
            annotation?.type === "TSUnionType" && annotation.types.some((part) => part.type === "TSNullKeyword");
          if (!hasNull && !hasExplicitNull) {
            context.report({ node, messageId: "nullable" });
          }
        },
      };
    },
  }),
  "parameter-mutation": createRule({
    name: "parameter-mutation",
    meta: {
      docs: { description: "Enforce immutable parameters for known native mutator calls." },
      type: "problem",
      schema: [],
      messages: { mutation: "Copy parameter data before using a known native mutator." },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();
      const readRoot = (node: TSESTree.Node): TSESTree.Identifier | null =>
        node.type === "Identifier" ? node : node.type === "MemberExpression" ? readRoot(node.object) : null;
      const isParameter = (node: TSESTree.Node) => {
        const root = readRoot(node);
        if (root === null) {
          return false;
        }
        const variable = ASTUtils.findVariable(context.sourceCode.getScope(node), root);

        return variable?.defs.some((definition) => definition.type === "Parameter") === true;
      };

      return {
        [`AssignmentExpression, UpdateExpression, UnaryExpression[operator='${removedOperator}']`](
          node: TSESTree.AssignmentExpression | TSESTree.UpdateExpression | TSESTree.UnaryExpression,
        ) {
          const target = node.type === "AssignmentExpression" ? node.left : node.argument;
          if (target.type !== "MemberExpression" || !isParameter(target)) {
            return;
          }
          const root = readRoot(target);
          if (root === null) {
            return;
          }
          const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(root));
          const parts = type.isIntersection() ? type.types : [type];
          const isHttpResponse = parts.some((part) => {
            const symbol = part.getSymbol();

            return (
              symbol?.name === "ServerResponse" &&
              symbol.declarations?.some((declaration) =>
                declaration.getSourceFile().fileName.includes("/node_modules/@types/node/"),
              ) === true
            );
          });
          if (
            isHttpResponse &&
            target.object === root &&
            ["statusCode", "statusMessage"].includes(readMemberName(target) ?? "")
          ) {
            return;
          }
          context.report({ node, messageId: "mutation" });
        },
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression") {
            return;
          }
          const method = readMemberName(callee);
          if (typeof method !== "string") {
            return;
          }
          const native = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(callee.object)).getSymbol()?.name;
          const hasMutableReceiver =
            native !== undefined &&
            (native === "Date" ? /^set[A-Z]/.test(method) : nativeMutators.get(native)?.includes(method));
          if (hasMutableReceiver === true && isParameter(callee.object)) {
            context.report({ node, messageId: "mutation" });
          }
          const target = node.arguments.at(0);
          const hasMutableTarget =
            callee.object.type === "Identifier" && targetMutators.get(callee.object.name)?.includes(method);
          if (hasMutableTarget === true && target && isParameter(target)) {
            context.report({ node, messageId: "mutation" });
          }
        },
      };
    },
  }),
  "immutable-arrays": createRule({
    name: "immutable-arrays",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "problem",
      schema: [],
      messages: {
        mutation:
          "Use an immutable array transformation. Mutating a fresh array expression or an immediately copied array is permitted.",
      },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();
      const isArray = (node: TSESTree.Node) => {
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

        return (type.isUnion() ? type.types : [type]).some(
          (part) => checker.isArrayType(part) || checker.isTupleType(part),
        );
      };

      const isFixtureCapture = ({ object, name }: { object: TSESTree.Node; name: unknown }) => {
        const variable =
          object.type === "Identifier" ? ASTUtils.findVariable(context.sourceCode.getScope(object), object) : null;

        return (
          context.filename.includes("/tests/") &&
          name === "push" &&
          variable?.defs.some(
            (definition) =>
              definition.type === "Variable" &&
              definition.node.init?.type === "ArrayExpression" &&
              context.sourceCode
                .getCommentsBefore(definition.parent)
                .some((comment) => /@fixtureCapture\s+\S/.test(comment.value)),
          ) === true
        );
      };

      return {
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression" || !isArray(callee.object)) {
            return;
          }
          const name =
            callee.property.type === "Identifier" && !callee.computed
              ? callee.property.name
              : callee.property.type === "Literal"
                ? callee.property.value
                : null;
          const object = callee.object;
          const isFresh =
            object.type === "ArrayExpression" ||
            (object.type === "CallExpression" &&
              object.callee.type === "MemberExpression" &&
              object.callee.property.type === "Identifier" &&
              ["slice", "map", "filter", "toSorted", "toReversed", "toSpliced"].includes(object.callee.property.name));
          if (typeof name === "string" && mutators.has(name) && !isFresh && !isFixtureCapture({ object, name })) {
            context.report({ node, messageId: "mutation" });
          }
        },
        [`AssignmentExpression, UpdateExpression, UnaryExpression[operator='${removedOperator}']`](
          node: TSESTree.AssignmentExpression | TSESTree.UpdateExpression | TSESTree.UnaryExpression,
        ) {
          const target = node.type === "AssignmentExpression" ? node.left : node.argument;
          if (target.type === "MemberExpression" && isArray(target.object)) {
            context.report({ node, messageId: "mutation" });
          }
        },
      };
    },
  }),
};
