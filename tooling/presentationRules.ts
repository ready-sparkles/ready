import type { TSESTree } from "@typescript-eslint/utils";
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(() => "docs/lint-policy.md");
export const presentationRules = {
  "used-react-props": createRule({
    name: "used-react-props",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "suggestion",
      schema: [],
      messages: { unused: "Remove the unused authored React prop field {{name}} or read it in the component." },
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();
      const readComponentName = (
        node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
      ) => {
        if (node.type === "FunctionDeclaration") {
          return node.id?.name ?? null;
        }

        return node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
          ? node.parent.id.name
          : null;
      };

      return {
        "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression"(
          node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
        ) {
          const name = readComponentName(node);
          if (name === null || !/^[A-Z]/.test(name) || node.params.length !== 1) {
            return;
          }
          const parameter = node.params.at(0);
          if (!parameter) {
            return;
          }
          const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(parameter));
          const fields = type
            .getProperties()
            .filter(
              (field) =>
                field.declarations?.some((declaration) =>
                  /\/(?:web|api|assistant|db|shared|openai-responses)\/presentation\/|\/web\/app\//.test(
                    declaration.getSourceFile().fileName,
                  ),
                ) === true,
            );
          if (parameter.type === "ObjectPattern") {
            if (parameter.properties.some((property) => property.type === "RestElement")) {
              return;
            }
            const used = parameter.properties.flatMap((property) =>
              property.type === "Property" && property.key.type === "Identifier" ? [property.key.name] : [],
            );
            fields
              .filter((field) => !used.includes(field.name))
              .forEach((field) => {
                context.report({ node: parameter, messageId: "unused", data: { name: field.name } });
              });
          } else if (parameter.type === "Identifier") {
            const variable = context.sourceCode
              .getDeclaredVariables(node)
              .find((binding) => binding.name === parameter.name);
            const references = variable?.references.filter((reference) => reference.isRead()) ?? [];
            // Escaping/spreading the whole props object makes individual reads unprovable.
            if (
              references.some(
                (reference) =>
                  reference.identifier.parent.type !== "MemberExpression" || reference.identifier.parent.computed,
              )
            ) {
              return;
            }
            const used = references.flatMap((reference) =>
              reference.identifier.parent.type === "MemberExpression" &&
              reference.identifier.parent.property.type === "Identifier"
                ? [reference.identifier.parent.property.name]
                : [],
            );
            fields
              .filter((field) => !used.includes(field.name))
              .forEach((field) => {
                context.report({ node: parameter, messageId: "unused", data: { name: field.name } });
              });
          }
        },
      };
    },
  }),
};
