// Keep this independently compiled Tailwind sheet out of the editor's global
// layer order. The calendar theme also follows its floating menus and dialogs.
export const scopeCalendarCss = {
  postcssPlugin: 'blok-calendar-scope',
  OnceExit(root, { AtRule }) {
    if (!root.source?.input.file?.endsWith('/calendarcn/theme.css')) return;
    root.walkAtRules('layer', layer => {
      if (layer.nodes) layer.replaceWith(...layer.nodes);
      else layer.remove();
    });
    root.walkRules(rule => {
      if (rule.parent.type === 'rule' || rule.parent.name?.endsWith('keyframes')) return;
      rule.selector = rule.selector.replace(/:root|:host\b/g, ':scope').replace(/html\.dark/g, ':scope.dark');
      const scope = new AtRule({ name: 'scope', params: '(.blok-calendarcn)' });
      rule.replaceWith(scope);
      scope.append(rule);
    });
  },
};
