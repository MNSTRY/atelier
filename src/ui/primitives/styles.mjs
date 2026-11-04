/**
 * Tenant-neutral carousel geometry and interaction styles. Tenants theme only
 * through the --system-carousel-* custom properties; markup contract in
 * docs/reference/ui-primitives.md.
 */
export const carouselStyles = `
.system-carousel { position: relative; }
.system-carousel [data-carousel-viewport] {
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scroll-snap-type: x mandatory;
  scroll-padding-inline: var(--system-carousel-inset, 0px);
  scrollbar-width: none;
}
.system-carousel [data-carousel-viewport]::-webkit-scrollbar { display: none; }
.system-carousel [data-carousel-track] {
  display: flex;
  gap: var(--system-carousel-gap, 1.25rem);
  padding-inline: var(--system-carousel-inset, 0px);
}
.system-carousel [data-carousel-track] > * {
  flex: 0 0 var(--system-carousel-slide, 100%);
  min-width: 0;
  scroll-snap-align: var(--system-carousel-align, start);
}
.system-carousel[data-peek] [data-carousel-track] > * { scroll-snap-align: center; }
.system-carousel[data-drift] [data-carousel-viewport] { scroll-snap-type: none; }
.system-carousel[data-fit="current"] [data-carousel-viewport] { transition: height 0.3s var(--system-carousel-ease, ease); }
.system-carousel img { -webkit-user-drag: none; }
@media (hover: hover) and (pointer: fine) {
  .system-carousel[data-ready][data-overflow="true"] [data-carousel-viewport] { cursor: grab; }
}
.system-carousel[data-dragging] [data-carousel-viewport],
.system-carousel[data-dragging] [data-carousel-viewport] * { cursor: grabbing; user-select: none; -webkit-user-select: none; }

.system-carousel[data-peek] [data-carousel-track] > * {
  transform: scale(calc(1 - var(--d, 0) * var(--system-carousel-recede-scale, 0.08)));
  opacity: calc(1 - var(--d, 0) * var(--system-carousel-recede-fade, 0.35));
}
.system-carousel[data-row] [data-carousel-track] { justify-content: center; }
.system-carousel[data-row] [data-carousel-track] > * { flex-basis: var(--slide-fit); transform: none; opacity: 1; }

.system-carousel[data-carousel="fade"] [data-carousel-track] { display: grid; }
.system-carousel[data-carousel="fade"] [data-carousel-track] > * {
  grid-area: 1 / 1;
  transition: opacity var(--system-carousel-fade-ms, 700ms) var(--system-carousel-ease, ease), visibility 0s linear var(--system-carousel-fade-ms, 700ms);
}
.system-carousel[data-carousel="fade"][data-ready] [data-carousel-track] > *:not(.is-current) { opacity: 0; visibility: hidden; }
.system-carousel[data-carousel="fade"][data-ready] [data-carousel-track] > *.is-current { opacity: 1; visibility: visible; transition-delay: 0s; }

.system-carousel__controls {
  display: flex;
  align-items: center;
  justify-content: var(--system-carousel-controls-justify, center);
  gap: var(--system-carousel-controls-gap, 1.25rem);
  margin-top: var(--system-carousel-controls-offset, 1.5rem);
}
.system-carousel__controls[hidden], .system-carousel__controls [hidden] { display: none; }
.system-carousel__buttons { display: flex; gap: 0.5rem; }
.system-carousel__button {
  display: grid;
  place-items: center;
  width: var(--system-carousel-button-size, 44px);
  height: var(--system-carousel-button-size, 44px);
  padding: 0;
  border: 1px solid var(--system-carousel-button-border, currentColor);
  border-radius: var(--system-carousel-button-radius, 0);
  background: var(--system-carousel-button-background, transparent);
  color: inherit;
  cursor: pointer;
  transition: background-color 0.24s var(--system-carousel-ease, ease), border-color 0.24s var(--system-carousel-ease, ease), opacity 0.24s var(--system-carousel-ease, ease);
}
.system-carousel__button:disabled { opacity: 0.32; cursor: default; }
.system-carousel__button:active:not(:disabled) { transform: translateY(1px); }
.system-carousel__button:focus-visible, .system-carousel__page:focus-visible {
  outline: 2px solid var(--system-carousel-focus, currentColor);
  outline-offset: 3px;
}
@media (hover: hover) and (pointer: fine) {
  .system-carousel__button:not(:disabled):hover {
    background: var(--system-carousel-button-hover-background, rgba(0, 0, 0, 0.06));
    border-color: var(--system-carousel-button-hover-border, currentColor);
  }
}
.system-carousel__toggle .system-carousel__play,
.system-carousel__toggle[data-state="paused"] .system-carousel__pause { display: none; }
.system-carousel__toggle[data-state="paused"] .system-carousel__play { display: block; }

.system-carousel__scrollbar {
  position: relative;
  width: var(--system-carousel-scrollbar-width, min(260px, 38vw));
  height: 28px;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.system-carousel__scrollbar::before, .system-carousel__scrollbar > span {
  content: '';
  position: absolute;
  top: 50%;
  height: var(--system-carousel-scrollbar-thickness, 2px);
  transform: translateY(-50%);
}
.system-carousel__scrollbar::before { left: 0; right: 0; background: var(--system-carousel-scrollbar-track, rgba(0, 0, 0, 0.14)); }
.system-carousel__scrollbar > span { left: 0; width: 25%; background: var(--system-carousel-scrollbar-thumb, currentColor); transition: height 0.16s var(--system-carousel-ease, ease); }
.system-carousel__scrollbar:hover > span, .system-carousel[data-scrubbing] .system-carousel__scrollbar > span { height: calc(var(--system-carousel-scrollbar-thickness, 2px) * 2); }
.system-carousel[data-scrubbing] .system-carousel__scrollbar { cursor: grabbing; }

.system-carousel__pages { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.25rem; }
.system-carousel__page { width: 24px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer; display: grid; place-items: center; color: inherit; }
.system-carousel__page::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.3; transition: opacity 0.24s var(--system-carousel-ease, ease); }
.system-carousel__page[aria-current="true"]::before { opacity: 1; }
.system-carousel__page[data-thumb] { width: var(--system-carousel-thumb-width, 72px); height: var(--system-carousel-thumb-height, 90px); opacity: 0.55; background: var(--thumb, none) center / cover; outline-offset: 2px; }
.system-carousel__page[data-thumb]::before { content: none; }
.system-carousel__page[data-thumb] img { width: 100%; height: 100%; object-fit: cover; }
.system-carousel__page[data-thumb][aria-current="true"] { opacity: 1; box-shadow: 0 0 0 1px var(--system-carousel-thumb-current, currentColor); }
.system-carousel__status {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .system-carousel [data-carousel-track] > *, .system-carousel__button, .system-carousel__scrollbar > span,
  .system-carousel[data-fit="current"] [data-carousel-viewport] { transition: none; }
  .system-carousel[data-peek] [data-carousel-track] > * { transform: none; }
}
`
