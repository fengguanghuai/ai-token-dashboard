# Bklit chart source

Selected MIT components from https://github.com/bklit/bklit-ui, installed through
https://ui.bklit.com/r/line-chart.json into the local showcase on 2026-09-14.
Only the line-chart dependency closure is imported; Studio is not included.

Local adaptations: relative utility imports, corrected shimmering-text path,
Chinese short-date formatting, and scoped generated Tailwind utilities.
The adapter in dashboard/BklitTrend.jsx owns data, accessibility, theme, range
controls and reduced-motion behavior. ECharts remains available for stacked/bar,
empty/single-day/over-400-day views, and runtime loading failures.

Regenerate CSS after utility changes (requires the showcase dependencies):

```
examples/ui-showcase/node_modules/.bin/tailwindcss -c src/client/vendor/bklit/tailwind.config.cjs -i src/client/vendor/bklit/utilities.input.css -o src/client/vendor/bklit/utilities.css --minify
```

The imported Visx 4 alpha dependencies are pinned in package.json; do not upgrade
them automatically without chart regression testing.

## MIT License

Copyright (c) 2026 uixmat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
