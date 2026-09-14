module.exports = {
  content: [__dirname + '/components/**/*.{ts,tsx}'],
  important: '.bklit-trend',
  corePlugins: { preflight:false },
  theme: {extend:{colors:{'chart-label':'var(--chart-label)'}}},
};
