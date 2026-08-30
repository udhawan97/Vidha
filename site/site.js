/* global document, window, IntersectionObserver */
/* Vidha public page · motion is optional, navigation is progressively enhanced. */

const root = document.documentElement;
const motionToggle = document.querySelector('[data-motion-toggle]');
const motionLabel = document.querySelector('[data-motion-label]');
const siteNav = document.querySelector('[data-site-nav]');
const revealScenes = [...document.querySelectorAll('.scene-reveal')];
const navSections = [...document.querySelectorAll('[data-nav-section]')];
const navLinks = [...document.querySelectorAll('.nav-link')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

root.dataset.motionControls = 'available';
root.dataset.sceneReveal = 'available';

let motionPaused = reducedMotion.matches;
let hasMotionOverride = false;

function renderMotionPreference() {
  const nextLabel = motionPaused
    ? 'Play ambient motion'
    : 'Pause ambient motion';

  root.dataset.motion = motionPaused ? 'paused' : 'running';
  motionToggle?.setAttribute('aria-pressed', String(motionPaused));
  motionToggle?.setAttribute('aria-label', nextLabel);
  motionToggle?.setAttribute('title', nextLabel);

  if (motionLabel) {
    motionLabel.textContent = nextLabel;
  }
}

motionToggle?.addEventListener('click', () => {
  hasMotionOverride = true;
  motionPaused = !motionPaused;
  renderMotionPreference();
});

function followSystemMotionPreference(event) {
  if (hasMotionOverride) return;
  motionPaused = event.matches;
  renderMotionPreference();
}

if ('addEventListener' in reducedMotion) {
  reducedMotion.addEventListener('change', followSystemMotionPreference);
} else {
  reducedMotion.addListener(followSystemMotionPreference);
}

renderMotionPreference();

let scrollFramePending = false;

function renderNavigationState() {
  siteNav?.classList.toggle('is-floating', window.scrollY > 80);
  scrollFramePending = false;
}

window.addEventListener(
  'scroll',
  () => {
    if (scrollFramePending) return;
    scrollFramePending = true;
    window.requestAnimationFrame(renderNavigationState);
  },
  { passive: true },
);

renderNavigationState();

if ('IntersectionObserver' in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.14 },
  );

  revealScenes.forEach((scene) => revealObserver.observe(scene));

  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const current = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

      if (!current) return;

      navLinks.forEach((link) => {
        const selected = link.getAttribute('href') === `#${current.target.id}`;
        if (selected) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    },
    { rootMargin: '-28% 0px -58% 0px', threshold: [0.05, 0.2, 0.45] },
  );

  navSections.forEach((section) => sectionObserver.observe(section));
} else {
  revealScenes.forEach((scene) => scene.classList.add('is-visible'));
}
