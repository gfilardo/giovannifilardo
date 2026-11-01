import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, unlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/build.mjs';
import { parseContent } from '../src/content.mjs';
import { preview } from '../src/preview.mjs';
import { verify } from '../src/output.mjs';
import { templates } from '../src/template.mjs';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
const article = (extra = '', body = 'Some **text**.') => `---\ntitle: Example\nslug: example\ndate: "2026-10-17"\ndescription: Example article\n${extra}\n---\n${body}`;
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['content', 'static', 'templates', 'site.config.json']) await cp(path.join(root, name), path.join(dir, name), { recursive: true });
  // Keep fixtures independent of additional articles in the actual blog.
  await rm(path.join(dir, 'content/posts'), { recursive: true });
  await mkdir(path.join(dir, 'content/posts'));
  await writeFile(path.join(dir, 'content/posts/hello-world.md'), `---\ntitle: Hello world\nslug: hello-world\ndate: "2026-10-17"\ndescription: A small place for notes, ideas, and things I am learning.\ntags:\n  - blogging\n  - software\ndraft: false\n---\nWelcome to my blog.\n`);
  await writeFile(path.join(dir, 'site.config.json'), JSON.stringify({ ...config, origin: 'https://example.com' }));
  return dir;
}
test('metadata schemas and source diagnostics', () => {
  for (const extra of ['date: "2026-02-30"', 'titel: typo', 'tags: [one, one]', 'draft: yes', 'slug: ../bad', 'updated: "2020-01-01"']) {
    assert.throws(() => parseContent('article.md', article(extra), 'post', config), /article.md:/);
  }
  assert.throws(() => parseContent('article.md', article().replace('2026-10-17', '2026-02-30'), 'post', config), /date/);
  assert.throws(() => parseContent('article.md', article('', '# Heading'), 'post', config), /##/);
  assert.throws(() => parseContent('article.md', article('', '[relative](other.md)'), 'post', config), /root-relative/);
  const parsed = parseContent('arbitrary-filename.md', article('tags: [node]'), 'post', config);
  assert.equal(parsed.route, '/posts/example/');
  assert.match(parsed.body, /<strong>text<\/strong>/);
});
test('template escaping, inheritance, and errors', () => {
  const env = templates(path.join(root, 'templates'));
  assert.equal(env.renderString('{{ title }}', { title: '<script>"&' }), '&lt;script&gt;&quot;&amp;');
  assert.throws(() => env.renderString('{{ missing }}', {}));
  assert.throws(() => env.renderString('{% if x %}', {}));
});
test('complete build, deterministic output, tags, stable permalinks and base paths', async t => {
  const dir = await fixture(t);
  const first = await build(dir);
  for (const name of ['feed.xml', 'sitemap.xml']) assert.equal(XMLValidator.validate(first.get(name)), true);
  const rss = new XMLParser().parse(first.get('feed.xml'));
  assert.equal(rss.rss.channel.title, config.title);
  const second = await build(dir);
  assert.deepEqual(first, second);
  assert.ok(first.has('tags/software/index.html'));
  assert.ok(first.has('404.html'));
  assert.ok(first.has('.nojekyll'));
  await rename(path.join(dir, 'content/posts/hello-world.md'), path.join(dir, 'content/posts/renamed.md'));
  assert.deepEqual(await build(dir), first);
  const prefixed = await build(dir, { basePath: '/my-blog' });
  assert.match(prefixed.get('index.html'), /href="\/my-blog\/posts\/hello-world\/"/);
  assert.match(prefixed.get('posts/hello-world/index.html'), /href="\/my-blog\/about\/"/);
  assert.match(prefixed.get('feed.xml'), /https:\/\/example.com\/my-blog\/posts\/hello-world\//);
  assert.match(prefixed.get('sitemap.xml'), /https:\/\/example.com\/my-blog\/tags\/software\//);
});
test('ordering, escaping, drafts, and automatic tag archives', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'content/posts/second.md'), article('tags: [node]'));
  const result = await build(dir);
  assert.ok(result.get('index.html').indexOf('/posts/example/') < result.get('index.html').indexOf('/posts/hello-world/'));
  assert.ok(result.has('tags/node/index.html'));
  await writeFile(path.join(dir, 'content/posts/second.md'), article('draft: true\ntags: [private]'));
  const hidden = await build(dir);
  assert.ok(!hidden.has('posts/example/index.html'));
  assert.ok(!hidden.has('tags/private/index.html'));
  for (const contents of hidden.values()) assert.ok(!String(contents).includes('/posts/example/'));
  await unlink(path.join(dir, 'content/posts/hello-world.md'));
  const empty = await build(dir);
  assert.match(empty.get('index.html'), /No articles published yet/);
});
test('failed builds preserve output; collisions and broken links are rejected', async t => {
  const dir = await fixture(t);
  await build(dir);
  const original = await readFile(path.join(dir, 'build/index.html'), 'utf8');
  await writeFile(path.join(dir, 'content/posts/broken.md'), article('', '[missing](/missing/)'));
  await assert.rejects(build(dir), /missing local target/);
  assert.equal(await readFile(path.join(dir, 'build/index.html'), 'utf8'), original);
  await unlink(path.join(dir, 'content/posts/broken.md'));
  await writeFile(path.join(dir, 'static/index.html'), 'collision');
  await assert.rejects(build(dir), /collision/);
  await unlink(path.join(dir, 'static/index.html'));
  await writeFile(path.join(dir, 'content/posts/duplicate.md'), (await readFile(path.join(dir, 'content/posts/hello-world.md'), 'utf8')));
  await assert.rejects(build(dir), /duplicate route/);
  await writeFile(path.join(dir, '.build.lock'), '');
  await assert.rejects(build(dir), /Another build/);
});
test('assets copy byte for byte and file/directory collisions fail', async t => {
  const dir = await fixture(t);
  await mkdir(path.join(dir, 'static/assets/posts/example'), { recursive: true });
  const bytes = Buffer.from([0, 1, 2, 255]);
  await writeFile(path.join(dir, 'static/assets/posts/example/image.png'), bytes);
  await writeFile(path.join(dir, 'content/posts/example.md'), article('', '![Sample](/assets/posts/example/image.png)'));
  const result = await build(dir, { basePath: '/blog' });
  assert.deepEqual(result.get('assets/posts/example/image.png'), bytes);
  assert.throws(() => verify(new Map([['about', 'file'], ['about/index.html', 'page']]), config), /collision/);
});
test('preview serves directory URLs, correct MIME, 404 and traversal rejection', async t => {
  const dir = await fixture(t);
  await build(dir, { basePath: '/blog' });
  const server = preview(dir, '/blog');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [url, expected] of [['/blog/', 200], ['/blog/about/', 200], ['/blog/missing/', 404], ['/site.config.json', 404], ['/blog/%2e%2e%2fsite.config.json', 400]]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, expected, url);
    await response.text();
  }
  const css = await fetch(`${origin}/blog/css/style.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  await css.text();
  const module = await fetch(`${origin}/blog/js/flock.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  await module.text();
});

test('invalid drafts are validated; pages can exist outside navigation', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'content/posts/draft.md'), article('draft: true').replace('slug: example', 'slug: INVALID'));
  await assert.rejects(build(dir), /draft.md/);
  await unlink(path.join(dir, 'content/posts/draft.md'));
  await writeFile(path.join(dir, 'content/pages/hidden.md'), '---\ntitle: Hidden\nslug: hidden\ndescription: Not in the menu\n---\nPage body');
  const result = await build(dir);
  assert.ok(result.has('hidden/index.html'));
  assert.ok(!result.get('index.html').includes('href="/hidden/"'));
  await writeFile(path.join(dir, 'content/posts/escape.md'), article().replace('title: Example', `title: '<script>alert("x")</script> & Example'`));
  const escaped = await build(dir);
  assert.ok(!escaped.get('posts/example/index.html').includes('<script>'));
  assert.equal(XMLValidator.validate(escaped.get('feed.xml')), true);
  await writeFile(path.join(dir, 'templates/post.html'), '{% broken %}');
  const previous = await readFile(path.join(dir, 'build/index.html'), 'utf8');
  await assert.rejects(build(dir));
  assert.equal(await readFile(path.join(dir, 'build/index.html'), 'utf8'), previous);
});

test('series metadata requires a stable id, title and positive integer part', () => {
  for (const series of [
    '{id: architecture, title: Architecture}',
    '{id: Invalid, title: Architecture, part: 1}',
    '{id: architecture, title: "", part: 1}',
    '{id: architecture, title: Architecture, part: 0}',
    '{id: architecture, title: Architecture, part: 1.5}',
    '{id: architecture, title: Architecture, part: 1, typo: true}'
  ]) assert.throws(() => parseContent('series.md', article(`series: ${series}`), 'post', config), /series.md/);
});

const seriesArticle = (slug, part, draft = false, title = 'Architecture & trade-offs') => article(
  `draft: ${draft}\nseries:\n  id: architecture\n  title: ${JSON.stringify(title)}\n  part: ${part}`,
  draft ? 'UNPUBLISHED BODY' : 'Published body'
).replace('slug: example', `slug: ${slug}`).replace('title: Example', `title: ${slug}`);

test('series lists ordered parts, exposes only draft titles and links published neighbors', async t => {
  const dir = await fixture(t);
  for (const [slug, part, draft] of [['last', 4, false], ['upcoming', 2, true], ['first', 1, false], ['middle', 3, false]]) {
    await writeFile(path.join(dir, `content/posts/${slug}.md`), seriesArticle(slug, part, draft));
  }
  const files = await build(dir, { basePath: '/blog' });
  const html = files.get('posts/middle/index.html');
  assert.match(html, /Part 3 of the series/);
  assert.match(html, /Architecture &amp; trade-offs/);
  assert.ok(html.indexOf('value="1"') < html.indexOf('value="2"'));
  assert.ok(html.indexOf('value="2"') < html.indexOf('value="3"'));
  assert.match(html, /value="3" aria-current="page"/);
  assert.match(html, /Coming soon/);
  assert.match(html, /rel="prev" href="\/blog\/posts\/first\/"/);
  assert.match(html, /rel="next" href="\/blog\/posts\/last\/"/);
  assert.ok(!files.has('posts/upcoming/index.html'));
  for (const [file, contents] of files) {
    if (!file.startsWith('preview/')) assert.ok(!String(contents).includes('UNPUBLISHED BODY'));
    assert.ok(!String(contents).includes('/posts/upcoming/'));
  }
  for (const name of ['index.html', 'feed.xml', 'sitemap.xml']) assert.ok(!String(files.get(name)).includes('upcoming'));
  assert.match(files.get('index.html'), /<p class="article-series">Architecture &amp; trade-offs · Part 3 of 4<\/p>/);
  assert.ok(!files.get('posts/hello-world/index.html').includes('class="series-nav"'));
  assert.ok(!files.get('posts/first/index.html').includes('rel="prev"'));
  assert.ok(!files.get('posts/last/index.html').includes('rel="next"'));
  await writeFile(path.join(dir, 'content/posts/upcoming.md'), seriesArticle('upcoming', 2));
  const promoted = await build(dir, { basePath: '/blog' });
  assert.match(promoted.get('index.html'), /<p class="article-series">Architecture &amp; trade-offs · Part 3 of 4<\/p>/);
  assert.match(promoted.get('posts/middle/index.html'), /rel="prev" href="\/blog\/posts\/upcoming\/"/);
  assert.ok(!promoted.get('posts/middle/index.html').includes('Coming soon'));
});

test('series conflicts fail safely, including draft conflicts; gaps and single parts work', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'content/posts/one.md'), seriesArticle('one', 3));
  const first = await build(dir);
  assert.match(first.get('posts/one/index.html'), /Part 3 of the series/);
  assert.match(first.get('index.html'), /<p class="article-series">Architecture &amp; trade-offs · Part 3<\/p>/);
  assert.ok(!first.get('posts/one/index.html').includes('class="series-pagination"'));
  await writeFile(path.join(dir, 'content/posts/two.md'), seriesArticle('two', 3, true));
  await assert.rejects(build(dir), /two.md: duplicate part 3/);
  assert.equal(await readFile(path.join(dir, 'build/posts/one/index.html'), 'utf8'), first.get('posts/one/index.html'));
  await writeFile(path.join(dir, 'content/posts/two.md'), seriesArticle('two', 4, true, 'Different title'));
  await assert.rejects(build(dir), /two.md: series architecture title differs/);
});

test('tags preserve display spelling and derive stable lowercase URLs everywhere', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'content/posts/tagged.md'), article('tags: [API_design, Domain-driven_design]'));
  const files = await build(dir, { basePath: '/blog' });
  for (const name of ['index.html', 'tags/index.html', 'posts/example/index.html', 'tags/api-design/index.html']) {
    assert.match(files.get(name), /API design/);
    assert.ok(!files.get(name).includes('API_design'));
  }
  assert.match(files.get('posts/example/index.html'), /href="\/blog\/tags\/api-design\/"/);
  assert.match(files.get('tags/domain-driven-design/index.html'), /<h1>Domain-driven design<\/h1>/);
  assert.match(files.get('feed.xml'), /<category>API design<\/category>/);
  assert.match(files.get('sitemap.xml'), /\/blog\/tags\/api-design\//);
  assert.ok(files.has('tags/software/index.html'));
  assert.deepEqual(await build(dir, { basePath: '/blog' }), files);
});

test('tag collisions fail with both sources, including drafts, and preserve previous output', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'content/posts/a.md'), article('tags: [API_design]'));
  const original = await build(dir);
  for (const tag of ['api_design', 'API-design']) {
    await writeFile(path.join(dir, 'content/posts/b.md'), article(`tags: [${tag}]\ndraft: true`).replace('slug: example', 'slug: other'));
    await assert.rejects(build(dir), error => {
      assert.match(error.message, /b.md/);
      assert.match(error.message, /a.md/);
      assert.match(error.message, /both use \/tags\/api-design\//);
      return true;
    });
    assert.equal(await readFile(path.join(dir, 'build/index.html'), 'utf8'), original.get('index.html'));
  }
  await writeFile(path.join(dir, 'content/posts/b.md'), article('tags: [API_design]').replace('slug: example', 'slug: other'));
  const files = await build(dir);
  assert.match(files.get('tags/api-design/index.html'), /href="\/posts\/other\/"/);
  assert.match(files.get('tags/api-design/index.html'), /href="\/posts\/example\/"/);
  await unlink(path.join(dir, 'content/posts/b.md'));
  await writeFile(path.join(dir, 'content/posts/a.md'), article('tags: [API_design, api_design]'));
  await assert.rejects(build(dir), /tag "api_design" conflicts/);
});

test('tag metadata rejects whitespace, punctuation and repeated separators', () => {
  for (const tag of ['API design', '_API', 'API_', 'API__design', 'API--design', 'API_-design', 'C++', '../api']) {
    assert.throws(() => parseContent('tags.md', article(`tags: [${JSON.stringify(tag)}]`), 'post', config), /tags.md/);
  }
});

test('image layout hints via URL fragments, captions, and diagnostics', () => {
  const defaultParsed = parseContent('fig.md', article('', '![Alt text](/assets/diagram.png "Figure 1: Diagram caption")'), 'post', config);
  assert.match(defaultParsed.body, /<figure class="image-figure image-default"><img src="\/assets\/diagram\.png" alt="Alt text" loading="lazy"><figcaption>Figure 1: Diagram caption<\/figcaption><\/figure>/);

  const floatRight = parseContent('fig.md', article('', '![Alt](/assets/cluster.png#float-right)'), 'post', config);
  assert.match(floatRight.body, /<figure class="image-figure image-float-right"><img src="\/assets\/cluster\.png" alt="Alt" loading="lazy"><\/figure>/);

  const wideFramed = parseContent('fig.md', article('', '![Wide](/assets/wide.png#wide+frame "Wide *caption* with [link](/about/)")'), 'post', config);
  assert.match(wideFramed.body, /<figure class="image-figure image-wide image-frame"><img src="\/assets\/wide\.png" alt="Wide" loading="lazy"><figcaption>Wide <em>caption<\/em> with <a href="\/about\/">link<\/a><\/figcaption><\/figure>/);

  const bleed = parseContent('fig.md', article('', '![Bleed](/assets/hero.jpg#bleed)'), 'post', config);
  assert.match(bleed.body, /<figure class="image-figure image-bleed"><img src="\/assets\/hero\.jpg" alt="Bleed" loading="lazy"><\/figure>/);

  const linked = parseContent('fig.md', article('', '[![Alt](/assets/linked.png#narrow)](/assets/linked.png)'), 'post', config);
  assert.match(linked.body, /<figure class="image-figure image-narrow"><a href="\/assets\/linked\.png"><img src="\/assets\/linked\.png" alt="Alt" loading="lazy"><\/a><\/figure>/);

  const inline = parseContent('fig.md', article('', 'Check this ![badge](/assets/badge.png#frame) icon inline.'), 'post', config);
  assert.match(inline.body, /<p>Check this <img src="\/assets\/badge\.png" alt="badge" loading="lazy" class="image-frame"> icon inline\.<\/p>/);

  assert.throws(() => parseContent('fig.md', article('', '![Alt](/assets/photo.png#flaot-right)'), 'post', config), /Unknown image layout hint: "flaot-right"/);

  assert.throws(() => parseContent('fig.md', article('', '![Alt](/assets/photo.png#float-left+float-right)'), 'post', config), /Conflicting image layout hints/);

  assert.throws(() => parseContent('fig.md', article('', 'Text before ![Alt](/assets/photo.png#float-right) text after.'), 'post', config), /cannot be inline with text/);
});


test('inline Mermaid renders accessible, deterministic diagrams with distinct IDs', () => {
  const diagram = '```mermaid Request <path>\nflowchart TD\n A[Browser] --> B[Application]\n```';
  const raw = article('', `${diagram}\n\n${diagram}\n\n\`\`\`js\nconst x = 1;\n\`\`\``);
  const first = parseContent('diagram.md', raw, 'post', config).body;
  assert.equal(first, parseContent('diagram.md', raw, 'post', config).body);
  assert.equal((first.match(/class="mermaid-diagram"/g) || []).length, 2);
  assert.match(first, /role="img" aria-label="Request &lt;path&gt;"/);
  assert.match(first, /<code class="language-js">/);
  assert.doesNotMatch(first, /<script|@import/);
  const ids = [...first.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, ref] of first.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref));
  assert.throws(() => parseContent('broken.md', article('', '```mermaid\nnot-a-diagram\n```'), 'post', config), /broken.md:/);
});

test('draft previews stay unlisted and move to published routes on release', async t => {
  const dir = await fixture(t);
  const draftPath = path.join(dir, 'content/posts/draft.md');
  const raw = article('draft: true\ntags: [preview_topic]', 'DRAFT BODY');
  await writeFile(draftPath, raw);
  let files = await build(dir, { basePath: '/blog' });
  assert.match(files.get('preview/index.html'), /href="\/blog\/preview\/example\/"/);
  assert.match(files.get('preview/example/index.html'), /DRAFT BODY/);
  assert.match(files.get('preview/example/index.html'), /noindex, nofollow/);
  assert.match(files.get('preview/example/index.html'), /href="\/blog\/preview\/"/);
  assert.ok(!files.has('posts/example/index.html'));
  assert.ok(!files.has('private/index.html'));
  assert.ok(!files.has('tags/preview-topic/index.html'));
  for (const file of ['index.html', 'tags/index.html', 'feed.xml', 'sitemap.xml']) {
    assert.doesNotMatch(files.get(file), /preview_topic|preview-topic|\/preview\//);
  }
  await writeFile(draftPath, raw.replace('draft: true', 'draft: false'));
  files = await build(dir);
  assert.ok(!files.has('preview/example/index.html'));
  await assert.rejects(readFile(path.join(dir, 'build/preview/example/index.html')), /ENOENT/);
  assert.match(files.get('feed.xml'), /posts\/example/);
  assert.ok(files.has('tags/preview-topic/index.html'));
  assert.doesNotMatch(files.get('posts/example/index.html'), /name="robots"/);
  assert.match(files.get('preview/index.html'), /No drafts to preview/);
  await writeFile(draftPath, raw);
  files = await build(dir);
  assert.ok(!files.has('posts/example/index.html'));
  assert.ok(files.has('preview/example/index.html'));
});

test('obsolete private metadata and preview route are rejected', async t => {
  assert.throws(() => parseContent('private.md', article('private: true'), 'post', config), /private.md:/);
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'content/pages/preview.md'), '---\ntitle: Preview\nslug: preview\ndescription: Collision\n---\nBody');
  await assert.rejects(build(dir), /reserved page slug preview/);
});

test('optional companion links render for articles and previews and require HTTPS', async t => {
  for (const companion of ['true', '"javascript:alert(1)"', '"../examples"', '"https://"']) {
    assert.throws(() => parseContent('article.md', article(`companion: ${companion}`), 'post', config), /article.md:/);
  }
  const dir = await fixture(t);
  const url = 'https://github.com/gfilardo/gf-blog-examples/tree/main/example';
  const file = path.join(dir, 'content/posts/example.md');
  await writeFile(file, article(`companion: ${url}`));
  const published = await build(dir);
  assert.ok(published.get('posts/example/index.html').includes(`href="${url}">companion examples</a>`));
  assert.ok(!published.get('posts/hello-world/index.html').includes('companion-note'));
  await writeFile(file, article(`companion: ${url}\ndraft: true`));
  const draft = await build(dir);
  assert.ok(draft.get('preview/example/index.html').includes(`href="${url}">companion examples</a>`));
  assert.ok(!draft.has('posts/example/index.html'));
});
