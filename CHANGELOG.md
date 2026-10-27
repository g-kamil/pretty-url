# Changelog

## 1.0.1

- Add a tag-driven release workflow that attests built release assets before publishing.
- Make plugin settings searchable in Obsidian 1.13+, while retaining the settings tab on older supported versions.
- Validate loaded settings through `unknown` and preserve defaults and card-width bounds for invalid saved values.
- Use renderer-window favicon state and Obsidian DOM helpers, preserving document ownership in popout windows.
- Remove an unnecessary regular-expression escape, redundant type assertions, and the deprecated slider tooltip call.
- Use the broadly supported page-break rule to keep printed cards together.
- Keep shared settings row data independent of the 1.13+ API types so the legacy renderer does not trigger unsupported-API warnings; clarify the invalid-selection notice.
- Refresh both screenshots with real site favicons in Reading view and Live Preview, and expand the copyable example to six sites.

## 1.0.0

- Initial public release.
- Render responsive URL card grids in Reading view and Live Preview using `url-cards` blocks, with titles and plain-text descriptions.
- Support exact per-block column counts with `c=N`.
- Automatically convert standalone web-link paragraphs and link-only lists into cards in Reading view.
- Insert example grids or convert selected links with the insert/convert command.
- Use theme-aware styles, keyboard focus, reduced-motion support, and print styles.
- Keep long URL addresses on one line with an ellipsis while preserving full link destinations.
- Offer default-off, direct site favicon fetching with a persistent local cache and a clear-cache control.
