const config = {
 content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}', './node_modules/@tremor/**/*.{js,ts,jsx,tsx}'],
 theme: { extend: { colors: { tremor: { brand: { faint:'#f5f3ff', muted:'#ddd6fe', subtle:'#a78bfa', DEFAULT:'#7c3aed', emphasis:'#6d28d9', inverted:'#fff' }, background: { muted:'#fafafa', subtle:'#f5f5f5', DEFAULT:'#fff', emphasis:'#404040' }, border: { DEFAULT:'#e5e5e5' }, ring: { DEFAULT:'#e5e5e5' }, content: { subtle:'#a3a3a3', DEFAULT:'#737373', emphasis:'#404040', strong:'#171717', inverted:'#fff' } } }, borderRadius:{'tremor-default':'0.5rem','tremor-small':'0.375rem','tremor-full':'9999px'}, fontSize:{'tremor-label':['0.75rem','1rem'],'tremor-default':['0.875rem','1.25rem'],'tremor-title':['1.125rem','1.75rem'],'tremor-metric':['1.875rem','2.25rem']} } },
 safelist: [{pattern: /^(bg|text|border|ring|stroke|fill)-(violet|indigo|cyan|amber|slate)-(50|100|200|300|400|500|600|700|800|900|950)$/}], plugins: []
};
Object.assign(config.theme.extend.colors, {
 background: 'var(--background)', foreground: 'var(--foreground)',
 border: 'var(--border)', muted: {DEFAULT:'var(--muted)', foreground:'var(--muted-foreground)'},
 card: {DEFAULT:'var(--card)',foreground:'var(--card-foreground)'},
});
export default config;
