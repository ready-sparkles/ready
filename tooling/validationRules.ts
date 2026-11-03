import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { ASTUtils, ESLintUtils } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = ESLintUtils.RuleCreator(() => "docs/lint-policy.md");

const unwrapParent = (node: TSESTree.Node): TSESTree.Node => {
  const parent = node.parent;

  return parent &&
    ["AwaitExpression", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(parent.type)
    ? unwrapParent(parent)
    : node;
};

const readMethod = (callee: TSESTree.MemberExpression) =>
  callee.property.type === "Identifier" && !callee.computed
    ? callee.property.name
    : callee.property.type === "Literal"
      ? callee.property.value
      : null;

const isNextResponseImport = (symbol: ts.Symbol) =>
  symbol.declarations?.some((declaration) => {
    if (!ts.isImportSpecifier(declaration) || (declaration.propertyName ?? declaration.name).text !== "NextResponse") {
      return false;
    }
    const importDeclaration = declaration.parent.parent.parent;

    return (
      ts.isStringLiteral(importDeclaration.moduleSpecifier) && importDeclaration.moduleSpecifier.text === "next/server"
    );
  }) === true;

const isInstalledNextResponseJson = (declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined) =>
  declaration !== undefined &&
  ts.isMethodDeclaration(declaration) &&
  ts.isClassDeclaration(declaration.parent) &&
  declaration.parent.name?.text === "NextResponse" &&
  ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true &&
  /\/node_modules\/next\/dist\/server\/web\/spec-extension\/response\.d\.ts$/.test(
    declaration.getSourceFile().fileName,
  );

const isImportedNextResponseBuilder = ({ node, checker }: { node: ts.CallExpression; checker: ts.TypeChecker }) => {
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "json" ||
    !ts.isIdentifier(callee.expression) ||
    ![1, 2].includes(node.arguments.length)
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(callee.expression);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0 || !isNextResponseImport(symbol)) {
    return false;
  }
  const resolved = checker.getAliasedSymbol(symbol);

  return (
    resolved.name === "NextResponse" &&
    resolved.declarations?.some(
      (candidate) =>
        ts.isClassDeclaration(candidate) &&
        /\/node_modules\/next\/dist\/server\/web\/spec-extension\/response\.d\.ts$/.test(
          candidate.getSourceFile().fileName,
        ),
    ) === true &&
    isInstalledNextResponseJson(checker.getResolvedSignature(node)?.declaration)
  );
};

const hasLocalResponseBinding = ({
  node,
  sourceCode,
}: {
  node: TSESTree.CallExpression;
  sourceCode: TSESLint.SourceCode;
}) =>
  node.callee.type !== "MemberExpression" ||
  node.callee.object.type !== "Identifier" ||
  (ASTUtils.findVariable(sourceCode.getScope(node), node.callee.object)?.defs.length ?? 0) !== 0;

const isNativeResponseBuilder = ({
  node,
  checker,
  hasLocalBinding,
}: {
  node: ts.CallExpression;
  checker: ts.TypeChecker;
  hasLocalBinding: boolean;
}) => {
  const callee = node.expression;
  if (
    hasLocalBinding ||
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "json" ||
    !ts.isIdentifier(callee.expression) ||
    ![1, 2].includes(node.arguments.length)
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(callee.expression);
  const declaration = checker.getResolvedSignature(node)?.declaration;

  return (
    symbol?.name === "Response" &&
    symbol.declarations?.some(
      (candidate) =>
        ts.isVariableDeclaration(candidate) &&
        /\/node_modules\/typescript\/lib\/lib\.dom\.d\.ts$/.test(candidate.getSourceFile().fileName),
    ) === true &&
    declaration !== undefined &&
    ts.isMethodSignature(declaration) &&
    ts.isTypeLiteralNode(declaration.parent) &&
    /\/node_modules\/typescript\/lib\/lib\.dom\.d\.ts$/.test(declaration.getSourceFile().fileName)
  );
};

export const validationRules = {
  "validated-input": createRule({
    name: "validated-input",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "problem",
      schema: [],
      messages: {
        schema:
          "Validate JSON.parse and Request/Response.json data with a concrete Zod schema, directly or through a same-variable parse/safeParse without other raw-data reads. unknown/any schemas do not validate shape.",
      },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();
      const isValidation = (node: TSESTree.Node) => {
        if (
          node.type !== "CallExpression" ||
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier" ||
          !["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(node.callee.property.name)
        ) {
          return false;
        }
        const receiverNode = node.callee.object;
        const receiver = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(receiverNode));
        const output = receiver.getProperty("_output");
        if (
          !output ||
          !receiver.getProperty("_def") ||
          output.declarations?.some((declaration) =>
            declaration.getSourceFile().fileName.includes("/node_modules/zod/"),
          ) !== true
        ) {
          return false;
        }
        const input = receiver.getProperty("_input");
        if (!input) {
          return false;
        }
        const hasConcreteShape = (symbol: ts.Symbol) => {
          const type = checker.getTypeOfSymbolAtLocation(symbol, services.esTreeNodeToTSNodeMap.get(receiverNode));

          return !(type.isUnion() ? type.types : [type]).some(
            (part) => (part.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0,
          );
        };

        return hasConcreteShape(input) && hasConcreteShape(output);
      };
      const isValidated = (node: TSESTree.Node) => {
        const value = unwrapParent(node);
        const parent = value.parent;
        if (!parent) {
          return false;
        }
        if (isValidation(parent) && parent.type === "CallExpression" && parent.arguments[0] === value) {
          return true;
        }
        if (parent.type !== "VariableDeclarator" || parent.id.type !== "Identifier") {
          return false;
        }
        const declaration = parent;
        const variable = context.sourceCode.getDeclaredVariables(declaration).at(0);
        const reads = variable?.references.filter((reference) => reference.isRead()) ?? [];

        return (
          reads.length !== 0 &&
          reads.every(
            (reference) =>
              isValidation(reference.identifier.parent) &&
              reference.identifier.parent.type === "CallExpression" &&
              reference.identifier.parent.arguments[0] === reference.identifier &&
              reference.identifier.range[0] > value.range[1],
          )
        );
      };

      return {
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression") {
            return;
          }
          const isJsonParse =
            callee.object.type === "Identifier" && callee.object.name === "JSON" && readMethod(callee) === "parse";
          const receiver = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(callee.object));
          const isHttpJson =
            readMethod(callee) === "json" &&
            (["Request", "Response", "NextRequest", "NextResponse"].includes(receiver.getSymbol()?.name ?? "") ||
              checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(callee.object))?.name === "Response") &&
            !isImportedNextResponseBuilder({ node: services.esTreeNodeToTSNodeMap.get(node), checker }) &&
            !isNativeResponseBuilder({
              node: services.esTreeNodeToTSNodeMap.get(node),
              checker,
              hasLocalBinding: hasLocalResponseBinding({ node, sourceCode: context.sourceCode }),
            });
          if ((isJsonParse || isHttpJson) && !isValidated(node)) {
            context.report({ node, messageId: "schema" });
          }
        },
        MemberExpression(node) {
          const property = readMethod(node);
          if (property !== "body") {
            return;
          }
          const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
          const isUntypedBody = Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
          if (isUntypedBody && !isValidated(node)) {
            context.report({ node, messageId: "schema" });
          }
        },
      };
    },
  }),
};
