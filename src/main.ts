import { EditorView } from '@codemirror/view';
import {
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
  setIcon,
} from 'obsidian';
import type { App, MarkdownPostProcessorContext } from 'obsidian';
import { cardsToBlock, parseCards, webUrl } from './cards';
import type { UrlCard } from './cards';
import { parseCardFences } from './fences';
import type { CardFence } from './fences';
import { FaviconCache } from './favicons';

interface PrettyUrlSettings {
  automaticParagraphs: boolean;
  automaticLists: boolean;
  minimumCardWidth: number;
  favicons: boolean;
}

const DEFAULT_SETTINGS: PrettyUrlSettings = {
  automaticParagraphs: true,
  automaticLists: true,
  minimumCardWidth: 260,
  favicons: false,
};

const EXAMPLE = '```url-cards\n[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/reference/grids/)\n  Responsive grids and cards for documentation.\n\n[Obsidian](https://obsidian.md)\n  A connected workspace for your notes.\n```';

type RenderRecord = { original: HTMLElement } | { source: string };

interface FaviconIcon {
  element: HTMLElement;
  origin: string;
  requested: boolean;
  intersecting: boolean;
  resource: string | null;
  image: HTMLImageElement | null;
  document: FaviconDocument | null;
}

interface FaviconDocument {
  document: Document;
  observer: IntersectionObserver;
  visibilityObserver: MutationObserver;
  icons: Set<FaviconIcon>;
  hidden: Set<FaviconIcon>;
  visibilityScheduled: boolean;
}

export default class PrettyUrlPlugin extends Plugin {
  settings: PrettyUrlSettings = { ...DEFAULT_SETTINGS };
  private rendered = new Map<HTMLElement, RenderRecord>();
  private faviconCache: FaviconCache | null = null;
  private faviconOrigins = new WeakMap<HTMLElement, string>();
  private faviconIcons = new Map<HTMLElement, FaviconIcon>();
  private faviconDocuments = new Map<Document, FaviconDocument>();
  private faviconGeneration = 0;
  private faviconClearing = false;
  private faviconClearPromise: Promise<void> | null = null;
  private faviconsDisposed = false;

  async onload(): Promise<void> {
    const saved = await this.loadData();
    this.settings = {
      automaticParagraphs: typeof saved?.automaticParagraphs === 'boolean' ? saved.automaticParagraphs : true,
      automaticLists: typeof saved?.automaticLists === 'boolean' ? saved.automaticLists : true,
      minimumCardWidth: typeof saved?.minimumCardWidth === 'number' && Number.isFinite(saved.minimumCardWidth)
        ? Math.max(180, Math.min(420, saved.minimumCardWidth)) : 260,
      favicons: typeof saved?.favicons === 'boolean' ? saved.favicons : false,
    };
    const pluginDir = this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.faviconCache = new FaviconCache(this.app.vault.adapter, normalizePath(`${pluginDir}/favicon-cache`), async url => {
      const response = await requestUrl({ url, method: 'GET', throw: false, headers: { Accept: 'image/*', Referer: '' } });
      return { status: response.status, arrayBuffer: response.arrayBuffer };
    });
    this.faviconCache.setEnabled(this.settings.favicons);
    this.registerMarkdownCodeBlockProcessor('url-cards', (source, el, ctx) => {
      el.addClass('pretty-url-root');
      const options = this.cardFenceOptions(el, ctx);
      const { cards, errors } = parseCards(source);
      if (cards.length) el.appendChild(this.createGrid(cards, el.ownerDocument));
      const messages = errors.map(item => `Line ${item.line}: ${item.message}`);
      if (messages.length) this.appendErrors(el, messages);
      if (options) this.applyColumnOptions(el, options);
      if (!cards.length && !messages.length && !options?.error) {
        el.createDiv({ cls: 'pretty-url-empty', text: 'Add an http(s) URL or [Title](https://example.com) on each line.' });
      }
      const child = this.track(el, { source }, ctx);
      if (!options) {
        // Nested Live Preview widgets must finish rendering before DOM-to-source mapping.
        const observer = new MutationObserver(() => {
          if (!el.isConnected) return;
          observer.disconnect();
          if (!this.rendered.has(el)) return;
          const attached = this.cardFenceOptions(el, ctx);
          if (attached) this.applyColumnOptions(el, attached);
        });
        observer.observe(el.ownerDocument, { childList: true, subtree: true });
        child.register(() => observer.disconnect());
      }
    });
    this.registerEditorExtension(EditorView.updateListener.of(update => {
      if (!update.docChanged && !update.viewportChanged) return;
      update.view.requestMeasure({
        key: this,
        read: () => Array.from(update.view.dom.querySelectorAll<HTMLElement>('.pretty-url-root'))
          .filter(root => this.rendered.has(root))
          .map(root => ({ root, options: this.cardFenceOptions(root) })),
        write: records => {
          for (const { root, options } of records) {
            if (options && this.rendered.has(root)) this.applyColumnOptions(root, options);
          }
        },
      });
    }));
    this.registerMarkdownPostProcessor((el, ctx) => this.renderAutomatic(el, ctx));
    this.addSettingTab(new PrettyUrlSettingTab(this.app, this));
    this.addCommand({
      id: 'insert-url-card-grid',
      name: 'Insert URL card grid',
      editorCallback: editor => {
        const selection = editor.getSelection();
        let block = EXAMPLE;
        if (selection.trim()) {
          const { cards, errors } = parseCards(selection);
          if (errors.length || !cards.length) {
            new Notice('Select URLs or Markdown links, one per line. Descriptions must be indented. Nothing was changed.');
            return;
          }
          block = cardsToBlock(cards);
        }
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const prefix = from.ch > 0 ? '\n\n' : from.line > 0 && editor.getLine(from.line - 1).trim() ? '\n' : '';
        const suffix = to.ch < editor.getLine(to.line).length ? '\n\n' : '\n';
        editor.replaceSelection(prefix + block + suffix);
      },
    });
    this.app.workspace.onLayoutReady(() => this.refresh());
  }

  /** Restore host Markdown immediately, even if a view is not rerendered on disable. */
  onunload(): void {
    this.faviconsDisposed = true;
    this.faviconGeneration++;
    this.faviconCache?.dispose();
    this.faviconCache = null;
    for (const document of this.faviconDocuments.values()) {
      document.observer.disconnect();
      document.visibilityObserver.disconnect();
    }
    this.faviconDocuments.clear();
    for (const state of this.faviconIcons.values()) this.detachFaviconImage(state);
    this.faviconIcons.clear();
    for (const [root, record] of this.rendered) {
      if ('original' in record) {
        root.replaceWith(record.original);
      } else {
        root.removeClass('pretty-url-root');
        root.empty();
        root.createEl('pre').createEl('code', { cls: 'language-url-cards', text: record.source });
      }
    }
    this.rendered.clear();
  }

  private track(root: HTMLElement, record: RenderRecord, ctx: MarkdownPostProcessorContext): MarkdownRenderChild {
    this.rendered.set(root, record);
    const child = new MarkdownRenderChild(root);
    const icons = this.trackFaviconIcons(root);
    child.register(() => {
      if (this.rendered.get(root) === record) this.rendered.delete(root);
      for (const state of icons) this.releaseFaviconIcon(state);
    });
    ctx.addChild(child);
    return child;
  }

  setFaviconsEnabled(enabled: boolean): void {
    this.settings.favicons = enabled;
    if (this.faviconsDisposed) return;
    this.faviconCache?.setEnabled(enabled && !this.faviconClearing);
    this.resetFaviconIcons();
    if (this.faviconsActive) {
      for (const state of this.faviconIcons.values()) this.observeFaviconIcon(state);
    }
  }

  clearFaviconCache(): Promise<void> {
    if (this.faviconClearPromise) return this.faviconClearPromise;
    const cache = this.faviconCache;
    if (!cache || this.faviconsDisposed) return Promise.resolve();
    this.faviconClearing = true;
    cache.setEnabled(false);
    this.resetFaviconIcons();
    this.faviconClearPromise = Promise.resolve().then(() => cache.clear()).finally(() => {
      this.faviconClearing = false;
      this.faviconClearPromise = null;
      if (this.faviconsDisposed) return;
      cache.setEnabled(this.settings.favicons);
      if (this.faviconsActive) {
        for (const state of this.faviconIcons.values()) this.observeFaviconIcon(state);
      }
    });
    return this.faviconClearPromise;
  }

  private get faviconsActive(): boolean {
    return this.settings.favicons && !this.faviconClearing && !this.faviconsDisposed && this.faviconCache !== null;
  }

  private trackFaviconIcons(root: HTMLElement): FaviconIcon[] {
    const icons: FaviconIcon[] = [];
    if (this.faviconsDisposed) return icons;
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('.pretty-url-icon'))) {
      const origin = this.faviconOrigins.get(element);
      if (!origin || this.faviconIcons.has(element)) continue;
      const state: FaviconIcon = {
        element, origin, requested: false, intersecting: false, resource: null, image: null, document: null,
      };
      this.faviconIcons.set(element, state);
      icons.push(state);
      if (this.faviconsActive) this.observeFaviconIcon(state);
    }
    return icons;
  }

  private observeFaviconIcon(state: FaviconIcon): void {
    if (!this.faviconsActive) return;
    const doc = state.element.ownerDocument;
    const win = doc.defaultView;
    if (!win?.IntersectionObserver) return;
    if (state.document && state.document.document !== doc) this.removeFaviconDocument(state);
    let document = this.faviconDocuments.get(doc);
    if (!document) {
      document = {
        document: doc,
        observer: new win.IntersectionObserver(entries => {
          if (!this.faviconsActive) return;
          for (const entry of entries) {
            const icon = this.faviconIcons.get(entry.target as HTMLElement);
            if (!icon || icon.document !== document) continue;
            icon.intersecting = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
            if (icon.intersecting) this.requestFavicon(icon);
            else if (document!.hidden.delete(icon)) this.watchHiddenFavicons(document!);
          }
        }, { root: null, rootMargin: '0px', threshold: 0 }),
        visibilityObserver: new win.MutationObserver(() => {
          if (!this.faviconsActive) return;
          for (const icon of Array.from(document!.hidden)) this.requestFavicon(icon);
        }),
        icons: new Set(),
        hidden: new Set(),
        visibilityScheduled: false,
      };
      this.faviconDocuments.set(doc, document);
    }
    state.document = document;
    document.icons.add(state);
    // IntersectionObserver also handles initial detached widgets when they attach.
    document.observer.observe(state.element);
  }

  private watchHiddenFavicons(document: FaviconDocument): void {
    if (document.visibilityScheduled) return;
    document.visibilityScheduled = true;
    queueMicrotask(() => {
      document.visibilityScheduled = false;
      if (!this.faviconsActive || this.faviconDocuments.get(document.document) !== document) return;
      document.visibilityObserver.disconnect();
      // Measuring previews can intersect but have visibility:hidden. Watch only
      // their ancestors, without polling or observing every document mutation.
      const ancestors = new Set<HTMLElement>();
      for (const icon of document.hidden) {
        for (let element: HTMLElement | null = icon.element; element; element = element.parentElement) ancestors.add(element);
      }
      for (const element of ancestors) {
        document.visibilityObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true });
      }
    });
  }

  private faviconVisible(state: FaviconIcon): boolean {
    const element = state.element;
    const win = element.ownerDocument.defaultView;
    if (!state.intersecting || !element.isConnected || !win) return false;
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    } else {
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        const style = win.getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || style.opacity === '0') return false;
      }
    }
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0
      && bounds.top < win.innerHeight && bounds.left < win.innerWidth;
  }

  private requestFavicon(state: FaviconIcon): void {
    if (!this.faviconsActive || this.faviconIcons.get(state.element) !== state || !state.intersecting) return;
    const document = state.document;
    if (document && document.document !== state.element.ownerDocument) {
      state.intersecting = false;
      this.observeFaviconIcon(state);
      return;
    }
    if (!this.faviconVisible(state)) {
      if (document && (!state.requested || state.resource) && !document.hidden.has(state)) {
        document.hidden.add(state);
        this.watchHiddenFavicons(document);
      }
      return;
    }
    if (document?.hidden.delete(state)) this.watchHiddenFavicons(document);
    if (state.requested) {
      if (state.resource && !state.image) this.loadFaviconImage(state, state.resource, this.faviconGeneration);
      return;
    }
    state.requested = true;
    const generation = this.faviconGeneration;
    void this.faviconCache!.get(state.origin).then(resource => {
      if (!this.currentFavicon(state, generation)) return;
      state.resource = resource;
      if (resource) this.requestFavicon(state);
      else state.document?.observer.unobserve(state.element);
    }, () => {
      if (this.currentFavicon(state, generation)) state.document?.observer.unobserve(state.element);
    });
  }

  private currentFavicon(state: FaviconIcon, generation: number): boolean {
    return this.faviconsActive && this.faviconGeneration === generation && this.faviconIcons.get(state.element) === state;
  }

  private loadFaviconImage(state: FaviconIcon, resource: string, generation: number): void {
    const image = state.element.ownerDocument.createElement('img');
    image.className = 'pretty-url-favicon';
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    state.image = image;
    image.onload = () => {
      if (!this.currentFavicon(state, generation) || state.image !== image || state.resource !== resource) return;
      image.onload = null;
      image.onerror = null;
      if (!state.element.isConnected) {
        state.image = null;
        return;
      }
      state.element.replaceChildren(image);
      state.document?.observer.unobserve(state.element);
    };
    image.onerror = () => {
      if (!this.currentFavicon(state, generation) || state.image !== image || state.resource !== resource) return;
      image.onload = null;
      image.onerror = null;
      state.image = null;
      state.resource = null;
      if (state.element.isConnected) setIcon(state.element, 'link');
      state.document?.observer.unobserve(state.element);
      void this.faviconCache!.markUnavailable(state.origin, resource).catch(() => undefined);
    };
    // Keep the standard link glyph in place until this local image decodes.
    image.src = resource;
  }

  private detachFaviconImage(state: FaviconIcon): void {
    const image = state.image;
    if (!image) return;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    state.image = null;
  }

  private resetFaviconIcons(): void {
    this.faviconGeneration++;
    for (const document of this.faviconDocuments.values()) {
      document.observer.disconnect();
      document.visibilityObserver.disconnect();
      document.hidden.clear();
    }
    for (const state of this.faviconIcons.values()) {
      const displayed = state.image?.parentElement === state.element;
      this.detachFaviconImage(state);
      if (displayed) setIcon(state.element, 'link');
      state.requested = false;
      state.intersecting = false;
      state.resource = null;
    }
  }

  private removeFaviconDocument(state: FaviconIcon): void {
    const document = state.document;
    if (!document) return;
    document.observer.unobserve(state.element);
    document.icons.delete(state);
    if (document.hidden.delete(state)) this.watchHiddenFavicons(document);
    if (!document.icons.size) {
      document.observer.disconnect();
      document.visibilityObserver.disconnect();
      this.faviconDocuments.delete(document.document);
    }
    state.document = null;
  }

  private releaseFaviconIcon(state: FaviconIcon): void {
    if (this.faviconIcons.get(state.element) !== state) return;
    this.faviconIcons.delete(state.element);
    this.detachFaviconImage(state);
    this.removeFaviconDocument(state);
  }

  private cardFenceOptions(el: HTMLElement, ctx?: MarkdownPostProcessorContext): CardFence | undefined {
    let section = ctx?.getSectionInfo(el);
    let root = el.closest<HTMLElement>('.cm-embed-block') ?? el;
    if (!section) {
      const editorDOM = el.closest<HTMLElement>('.cm-editor');
      const editor = editorDOM ? EditorView.findFromDOM(editorDOM) : null;
      if (!editor || root === el) return;
      const doc = editor.state.doc;
      const first = doc.lineAt(editor.posAtDOM(root));
      let last = first.number;
      if (root.classList.contains('cm-callout')) {
        while (last < doc.lines && /^[ \t]*>/.test(doc.line(last + 1).text)) last++;
      } else {
        last = doc.lines;
      }
      section = { text: doc.toString(), lineStart: first.number - 1, lineEnd: last - 1 };
    }
    if (root === el) {
      while (root.parentElement && !root.parentElement.matches('.markdown-preview-section, .markdown-preview-view')) {
        const parent = ctx?.getSectionInfo(root.parentElement);
        if (!parent || parent.lineStart !== section.lineStart || parent.lineEnd !== section.lineEnd) break;
        root = root.parentElement;
      }
    }
    // Several blocks can share a callout/list section. Body text is not unique.
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.block-language-url-cards, code.language-url-cards'))
      .filter(block => block.classList.contains('block-language-url-cards') || !block.closest('.block-language-url-cards'));
    const index = root === el ? 0 : blocks.indexOf(el);
    const text = section.text.split(/\r?\n/).slice(section.lineStart, section.lineEnd + 1).join('\n');
    return parseCardFences(text)[index];
  }

  private applyColumnOptions(el: HTMLElement, options: CardFence): void {
    const grid = el.querySelector<HTMLElement>('.pretty-url-grid');
    if (grid) {
      grid.toggleClass('pretty-url-grid-fixed', options.columns !== undefined);
      if (options.columns !== undefined) grid.style.setProperty('--pretty-url-columns', String(options.columns));
      else grid.style.removeProperty('--pretty-url-columns');
    }
    const previous = el.querySelector<HTMLElement>('.pretty-url-column-error');
    if (previous?.textContent !== options.error) {
      const panel = previous?.closest('.pretty-url-errors');
      previous?.remove();
      if (panel && !panel.querySelector('li')) panel.remove();
      if (options.error) this.appendErrors(el, [options.error], true);
    }
  }

  private appendErrors(el: HTMLElement, messages: string[], columnError = false): void {
    let list = el.querySelector<HTMLUListElement>('.pretty-url-errors ul');
    if (!list) {
      const error = el.createDiv({ cls: 'pretty-url-errors' });
      error.setAttribute('role', 'status');
      error.createEl('strong', { text: 'URL card grid has errors' });
      list = error.createEl('ul');
    }
    for (const message of messages) list.createEl('li', { text: message, cls: columnError ? 'pretty-url-column-error' : undefined });
  }

  private createGrid(cards: UrlCard[], doc: Document): HTMLElement {
    const grid = doc.createElement('ul');
    grid.className = 'pretty-url-grid';
    grid.style.setProperty('--pretty-url-card-min-width', `${this.settings.minimumCardWidth}px`);
    for (const card of cards) {
      const item = grid.createEl('li', { cls: 'pretty-url-item' });
      const url = new URL(card.url);
      const link = item.createEl('a', { cls: 'pretty-url-card external-link', href: card.url });
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      const header = link.createSpan({ cls: 'pretty-url-header' });
      const icon = header.createSpan({ cls: 'pretty-url-icon' });
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, 'link');
      this.faviconOrigins.set(icon, url.origin);
      header.createSpan({ cls: 'pretty-url-title', text: card.title });
      if (card.description) link.createSpan({ cls: 'pretty-url-description', text: card.description });
      const footer = link.createSpan({ cls: 'pretty-url-footer' });
      footer.createSpan({ cls: 'pretty-url-address', text: url.host + (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash });
      const arrow = footer.createSpan({ cls: 'pretty-url-arrow' });
      arrow.setAttribute('aria-hidden', 'true');
      setIcon(arrow, 'arrow-up-right');
    }
    return grid;
  }

  /** Only a container composed entirely of external links and whitespace qualifies. */
  private linkCards(container: HTMLElement): UrlCard[] | null {
    const cards: UrlCard[] = [];
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const element = node as HTMLElement;
      if (container.tagName === 'LI') {
        if (element.matches('span.list-bullet, span.list-number')) continue;
        if (element.tagName === 'P') {
          const nested = this.linkCards(element);
          if (!nested) return null;
          cards.push(...nested);
          continue;
        }
      }
      if (element.tagName === 'BR') continue;
      if (element.tagName !== 'A' || !element.classList.contains('external-link')) return null;
      // Preserve images, formatting, and other plugins' richer link renderers.
      if (element.children.length) return null;
      const destination = element.getAttribute('href') ?? '';
      const url = webUrl(destination);
      if (!url) return null;
      const label = element.textContent?.trim() ?? '';
      const title = !label || label === destination || label === url.href ? url.hostname : label;
      cards.push({ url: url.href, title, description: '' });
    }
    return cards.length ? cards : null;
  }

  private renderAutomatic(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const candidates = Array.from(el.querySelectorAll<HTMLElement>('p, ul, ol'));
    if (el.matches('p, ul, ol')) candidates.unshift(el);
    for (const element of candidates) {
      if (!element.parentNode || element.closest('.pretty-url-root, li, pre, code')) continue;
      let cards: UrlCard[] | null = null;
      if (element.tagName === 'P') {
        if (!this.settings.automaticParagraphs) continue;
        cards = this.linkCards(element);
      } else {
        if (!this.settings.automaticLists) continue;
        cards = [];
        for (const item of Array.from(element.children)) {
          if (item.tagName !== 'LI') { cards = null; break; }
          const entry = this.linkCards(item as HTMLElement);
          if (!entry || entry.length !== 1) { cards = null; break; }
          cards.push(entry[0]);
        }
      }
      if (!cards?.length) continue;
      const root = element.ownerDocument.createElement('div');
      root.className = 'pretty-url-root';
      root.appendChild(this.createGrid(cards, element.ownerDocument));
      element.replaceWith(root);
      this.track(root, { original: element }, ctx);
    }
  }

  refresh(): void {
    for (const [root, record] of this.rendered) {
      if ('original' in record) {
        root.replaceWith(record.original);
        this.rendered.delete(root);
        for (const icon of Array.from(root.querySelectorAll<HTMLElement>('.pretty-url-icon'))) {
          const state = this.faviconIcons.get(icon);
          if (state) this.releaseFaviconIcon(state);
        }
      } else {
        root.querySelector<HTMLElement>('.pretty-url-grid')?.style.setProperty('--pretty-url-card-min-width', `${this.settings.minimumCardWidth}px`);
      }
    }
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
    });
  }
}

class PrettyUrlSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PrettyUrlPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('p', { text: 'URL card blocks work in Reading view and Live Preview. Automatic conversion applies only in Reading view; inline links and mixed-content lists are left untouched.' });
    new Setting(this.containerEl)
      .setName('Standalone URLs')
      .setDesc('Turn paragraphs containing only web links into cards in Reading view.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.automaticParagraphs).onChange(async value => {
        this.plugin.settings.automaticParagraphs = value;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.refresh();
      }));
    new Setting(this.containerEl)
      .setName('Link-only lists')
      .setDesc('Turn lists with exactly one web link per item into a card grid in Reading view.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.automaticLists).onChange(async value => {
        this.plugin.settings.automaticLists = value;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.refresh();
      }));
    new Setting(this.containerEl)
      .setName('Favicons')
      .setDesc('Opt in to direct requests to each visible card’s site for /favicon.ico. Your IP address is shared with that site; note URLs and referrers are not sent. Icons are cached locally until cleared.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.favicons).onChange(async value => {
        this.plugin.setFaviconsEnabled(value);
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName('Clear favicon cache')
      .setDesc('Remove cached icons and remembered failures. When favicons are enabled, only visible cards request fresh icons.')
      .addButton(button => button.setButtonText('Clear cache').onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.clearFaviconCache();
          new Notice('Favicon cache cleared.');
        } catch {
          new Notice('Could not clear the favicon cache.');
        } finally {
          button.setDisabled(false);
        }
      }));
    new Setting(this.containerEl)
      .setName('Minimum card width')
      .setDesc('Cards wrap into fewer columns when the note pane is narrow. In pixels.')
      .addSlider(slider => slider.setLimits(180, 420, 10).setValue(this.plugin.settings.minimumCardWidth).setDynamicTooltip().onChange(async value => {
        this.plugin.settings.minimumCardWidth = value;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.refresh();
      }));
  }
}
