# UI primitives

`@mnstry/atelier/ui/primitives` is the shared behaviour layer for sites and apps
built with Atelier. It sits beside the control system (`@mnstry/atelier/ui`) and
follows the same rules: no tenant content, plain HTML contracts that work
without script, and theming only through `--system-*` custom properties.

| Import | Runs in | Provides |
| --- | --- | --- |
| `@mnstry/atelier/ui/primitives` | Node and browsers | Pure state functions, `carouselStyles`, `renderCarouselControls` |
| `@mnstry/atelier/ui/primitives/browser` | Browsers | `enhanceCarousels`, `enhanceDisclosures`, `lockScroll` and `unlockScroll`, the motion owner |

The carousel brings together the Urana Heart site's carousel (seamless loops,
drag intent, focus safety, page dots and thumbnails, live status, height that
follows the slide, receding neighbours, still rows) and Botanika's additions (a
draggable scroll bar, momentum for multi-card strips, autoplay, a pause control).

## Carousel

### Markup contract

```html
<div class="system-carousel" data-carousel="track" data-select="visible" data-loop
     data-autoplay="discrete" data-interval="6000"
     role="region" aria-roledescription="carousel" aria-label="Featured collection">
  <div data-carousel-viewport tabindex="0" aria-label="Featured collection, scroll horizontally">
    <div data-carousel-track>
      <article>…</article>
      <article>…</article>
    </div>
  </div>
  <!-- optional: page dots or thumbnails -->
  <div class="system-carousel__pages">
    <button type="button" class="system-carousel__page" data-page aria-label="Show slide 1">…</button>
  </div>
  <!-- controls and status: renderCarouselControls({ label, autoplay }) -->
</div>
```

Without script, the viewport is a native horizontal scroller with snap points,
so touch, trackpad, wheel and keyboard scrolling all work. Slides are the
track's children; if any child carries `data-slide`, only those count.

### Options (attributes on the root)

| Attribute | Values | Effect |
| --- | --- | --- |
| `data-carousel` | `track` (default), `fade` | Scrolling strip, or slides crossfading in one grid cell |
| `data-select` | `current` (default), `visible` | `current` makes every slide except the current one inert (slideshows); `visible` keeps every card on screen interactive (product strips) |
| `data-step` | `item`, `page` | What an arrow moves. Defaults to `page` for `visible` and `item` for `current`. A loop barely longer than a page steps by the hidden remainder |
| `data-loop` | present | Seamless loop over inert clones; arrows never stop |
| `data-peek` | present | Centre-aligned slides; neighbours recede (`--d` from 0 to 1) and clicking one centres it; a still row when every card fits at `data-row-min` (default 400px) |
| `data-fit` | `current` | The viewport height follows the slide in view, blending as slides pass |
| `data-autoplay` | `off` (default), `discrete`, `smooth` | Advance one page every `data-interval` ms (at least 2500), or drift continuously at `data-speed` px/s |

### Behaviour

- **Mouse drag** on the slides: a drag starts only once horizontal movement
  clearly dominates, so vertical page scrolling is never taken over. Clicks at
  the end of a drag are swallowed; a plain click still follows its link.
  Slideshows step one slide (distance or flick); `visible` strips glide with
  capped momentum and settle on a card.
- **Scroll bar** (`[data-scrollbar]`): click to jump, or drag the thumb. It
  covers one set of slides in a loop.
- **Arrows, pages and keys:** Previous, Next, page buttons, and Left, Right,
  Home and End on the carousel. Reader-initiated moves are announced politely in
  `[data-status]`; autoplay moves are not.
- **Autoplay** never runs under reduced motion. It holds while the pointer is
  over the carousel, while focus is inside it, during a touch, wheel, drag or
  scrub, while the tab is hidden and while the carousel is off screen. The
  rendered toggle pauses and resumes it. `data-autoplay-state` reads `playing`,
  `held`, `paused` or `off`.
- **Focus:** before a slide becomes inert, focus moves to its page button or
  another control, so it is never lost.

The enhancer sets `data-ready`, `data-overflow`, `data-row`, `data-dragging`
and `data-scrubbing` for styling, and hides the controls when nothing overflows.
`enhanceCarousel(root)` returns `{ go, goTo, pause, play }`.

### Theming

Use `carouselStyles` once per page (for example
`<style set:html={carouselStyles}>`) and set custom properties on the carousel:

`--system-carousel-gap`, `-slide` (slide width), `-inset` (full-bleed side
padding), `-align`, `-ease`, `-focus`, `-button-size`, `-button-border`,
`-button-radius`, `-button-background`, `-button-hover-background`,
`-button-hover-border`, `-controls-justify`, `-controls-gap`,
`-controls-offset`, `-scrollbar-width`, `-scrollbar-thickness`,
`-scrollbar-track`, `-scrollbar-thumb`, `-thumb-width`, `-thumb-height`,
`-thumb-current`, `-recede-scale`, `-recede-fade`, `-fade-ms`.

## Disclosures

`enhanceDisclosures(root)` animates native `<details>`: open and close can be
reversed mid-way, `data-state` (`open` or `closed`) follows the reader's intent
at once so icons turn with the click, and reduced motion opens instantly.
Keyboard and no-script behaviour stay native.

## Scroll lock

`lockScroll(owner)` and `unlockScroll(owner)` implement the layout-stable host
lock described in [portable presentation](portable-presentation.md). The lock
hides page scrolling, pays the hidden scrollbar back as body end padding,
exposes it as `--scroll-lock-gap` for fixed and sticky elements (for example
`right: var(--scroll-lock-gap, 0px)` on a fixed panel), and counts owners so one
closing overlay cannot release another. The gap is measured as the growth of the
body's laid-out width, which stays correct with `scrollbar-gutter: stable` and
with overlay scrollbars.

## Motion

`animationAllowed()`, `onMotionChange(listener)` and `animate(element, frames,
options)` give one owner for motion: the reduced-motion preference and hidden
tabs stop every effect started through them. `startMotionWatch()` begins
watching; the carousel and disclosures call it as needed.
