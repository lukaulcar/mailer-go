import Prism from "prismjs";
import "prismjs/components/prism-css";


const templateVarPattern = /\{\{[a-zA-Z0-9_.\s|-]+\}\}/;


const PRISM_PATCH_FLAG = "__mailergo_template_var_patched__";
if (Prism.languages.markup && !(Prism.languages as any)[PRISM_PATCH_FLAG]) {
  
  Prism.languages.insertBefore("markup", "tag", {
    "template-variable": {
      pattern: templateVarPattern,
      alias: "variable",
    },
  });

  
  const tag = (Prism.languages.markup as any).tag;
  if (tag && tag.inside) {
    tag.inside["template-variable"] = {
      pattern: templateVarPattern,
      alias: "variable",
    };
    const attrValue = tag.inside["attr-value"];
    if (attrValue) {
      if (!attrValue.inside) {
        attrValue.inside = {};
      }
      attrValue.inside["template-variable"] = {
        pattern: templateVarPattern,
        alias: "variable",
      };
    }
  }
  (Prism.languages as any)[PRISM_PATCH_FLAG] = true;
}

export function highlightHtml(code: string): string {
  if (!code) return "";
  try {
    return Prism.highlight(code, Prism.languages.markup, "markup");
  } catch {
    return code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
