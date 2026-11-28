import type { Preview } from "@storybook/html-vite";

import {attachGrabToDialogs} from "../desktop/src/react-grab-dialogs";

const detachInspector = attachGrabToDialogs();
import.meta.hot?.dispose(detachInspector);

// Import global editor styles
import editorStyles from "../src/styles/main.css?inline";

// Use the same scoped CSS entry as the editor. The ordinary Vite CSS proxy
// is JavaScript and cannot pass through the CSS scoping post-transform.
const editorStyleElement = document.createElement("style");
editorStyleElement.textContent = editorStyles;
document.head.appendChild(editorStyleElement);
// Blok loads the font faces lazily; stories rendered without an editor still need them.
import "../src/styles/fonts.css";

// The desktop shell scopes its palette on the document as well as its mount.
// Dialogs and popovers attached to body need the same attributes in an isolated story.
let restoreDocumentTheme: (() => void) | undefined;

function setStoryTheme(theme: string, signal: AbortSignal): void {
  const roots = [document.documentElement, document.body];
  const previous = roots.map(root => root.getAttribute("data-blok-theme"));
  roots.forEach(root => root.setAttribute("data-blok-theme", theme));
  const restore = () => {
    if (restoreDocumentTheme !== restore) return;
    roots.forEach((root, index) => {
      const value = previous[index];
      if (value === null) root.removeAttribute("data-blok-theme");
      else root.setAttribute("data-blok-theme", value);
    });
    signal.removeEventListener("abort", restore);
    restoreDocumentTheme = undefined;
  };
  restoreDocumentTheme = restore;
  signal.addEventListener("abort", restore, {once:true});
}

const preview: Preview = {
  initialGlobals: {
    reactGrab: true,
  },
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#ffffff" },
        { name: "dark", value: "#1e1e1e" },
      ],
    },
    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: "error",
    },
  },
  decorators: [
    (story, context) => {
      if (context.viewMode === "story") restoreDocumentTheme?.();
      const container = document.createElement("div");
      const fullscreen = context.parameters.layout === "fullscreen";

      container.style.fontFamily =
        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif";
      if (fullscreen) {
        container.style.height = "100vh";
      } else {
        container.style.padding = "20px";
      }

      const storyContent = story();
      const isStringContent = typeof storyContent === "string";
      const isElementContent = storyContent instanceof HTMLElement;

      if (isStringContent) {
        container.innerHTML = storyContent;
      }

      if (isElementContent) {
        if (context.viewMode === "story" && fullscreen && context.title.startsWith("Shell/")) {
          const theme = storyContent.getAttribute("data-blok-theme");
          if (theme === "dark" || theme === "light") setStoryTheme(theme, context.abortSignal);
        }
        delete document.documentElement.dataset.shellLoadingTheme;
        container.appendChild(storyContent);
      }

      return container;
    },
  ],
};

export default preview;
