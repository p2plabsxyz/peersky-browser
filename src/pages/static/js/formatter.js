(function () {
  "use strict";
  function syntaxHighlight(json) {
    json = json
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\\s*:\\s*)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
      function (match) {
        let cls = "number";
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? "key" : "string";
        } else if (/true|false/.test(match)) {
          cls = "boolean";
        } else if (/null/.test(match)) {
          cls = "null";
        }
        return '<span class="' + cls + '">' + match + "</span>";
      }
    );
  }

  const rawText = document.body.textContent.trim();

  if (
    (rawText.startsWith("{") && rawText.endsWith("}")) ||
    (rawText.startsWith("[") && rawText.endsWith("]"))
  ) {
    try {
      const json = JSON.parse(rawText);
      const prettyJson = JSON.stringify(json, null, 2);
      const highlighted = syntaxHighlight(prettyJson);
      document.body.innerHTML = "<pre><code>" + highlighted + "</code></pre>";
      return;
    } catch (e) {
    }
  }

  document.body.innerHTML = "<pre><code>" + rawText + "</code></pre>";
})();
