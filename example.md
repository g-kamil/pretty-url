## A three-column card grid

This block forces three cards per row in Reading view and Live Preview, even in a narrow pane. Remove `c=3` to restore responsive columns. Move the caret into the block to edit it.

```url-cards c=3
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/reference/grids/)
  The inspiration: responsive grids, bordered cards, and hover elevation.

[Obsidian](https://obsidian.md)
  A connected workspace for your notes.

[MDN Web Docs](https://developer.mozilla.org/en-US/)
  Reference documentation for the web platform.

[TypeScript](https://www.typescriptlang.org/docs/)
  Typed JavaScript, with tools for reliable applications.
```

## Automatic link lists

In Reading view, this link-only list becomes another grid. In Live Preview it remains an ordinary list.

- [Obsidian Help](https://help.obsidian.md/)
- [Obsidian Developer Docs](https://docs.obsidian.md/)

## Standalone URLs

A URL on its own becomes a card in Reading view:

https://obsidian.md

Inline links such as [the Material reference](https://squidfunk.github.io/mkdocs-material/reference/grids/) stay inline.

## Make your own

Select whole lines of URLs or Markdown links and run **Pretty URL: Insert URL card grid**. With no selection, the same command inserts an example. Indent optional descriptions by two spaces. Configure automatic cards and minimum card width under **Settings → Pretty URL**.

Enable **Settings → Pretty URL → Favicons** to show each visible site's `/favicon.ico` when available. Missing icons keep the link glyph. Icons and failures are cached locally until you use **Clear favicon cache**; no page previews or external favicon service are fetched.
