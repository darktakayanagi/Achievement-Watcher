function getAnimatedElements() {
  return Array.from(document.querySelectorAll('*')).filter((el) => {
    const style = getComputedStyle(el);
    return style.animationName !== 'none' && parseFloat(style.animationDuration) > 0;
  });
}
function getTransitionedElements() {
  return Array.from(document.querySelectorAll('*')).filter((el) => {
    const style = getComputedStyle(el);
    return style.transitionDuration !== '0s' || style.transitionDelay !== '0s';
  });
}

function scaleTransitions(el, scale) {
  const style = getComputedStyle(el);

  const durations = style.transitionDuration.split(',').map((d) => parseFloat(d) * scale + 's');
  const delays = style.transitionDelay.split(',').map((d) => parseFloat(d) * scale + 's');
  const properties = style.transitionProperty.split(',');
  const timingFns = style.transitionTimingFunction.split(',');

  const newTransition = properties
    .map((prop, i) => {
      return [prop.trim(), durations[i] || durations[0], timingFns[i] || timingFns[0], delays[i] || delays[0]].join(' ');
    })
    .join(', ');

  el.style.transition = newTransition;
}

function scaleAnimationTimings(element, scaleFactor) {
  const computed = getComputedStyle(element);

  const durations = computed.animationDuration.split(',').map((s) => parseFloat(s) * scaleFactor + 's');
  const delays = computed.animationDelay.split(',').map((s) => parseFloat(s) * scaleFactor + 's');

  const names = computed.animationName.split(',');
  const timingFns = computed.animationTimingFunction.split(',');
  const iterationCounts = computed.animationIterationCount.split(',');
  const directions = computed.animationDirection.split(',');
  const fillModes = computed.animationFillMode.split(',');

  const animationValue = names
    .map((name, i) => {
      return [
        name.trim(),
        durations[i] || durations[0],
        timingFns[i] || timingFns[0],
        delays[i] || delays[0],
        iterationCounts[i] || iterationCounts[0],
        directions[i] || directions[0],
        fillModes[i] || fillModes[0],
      ].join(' ');
    })
    .join(', ');

  element.style.animation = animationValue;
}

window.addEventListener('DOMContentLoaded', () => {
  window.api.onAnimationScale((event, scale) => {
    const animatedElements = getAnimatedElements();
    const transitionedEls = getTransitionedElements();

    animatedElements.forEach((el) => scaleAnimationTimings(el, scale));
    transitionedEls.forEach((el) => scaleTransitions(el, scale));

    const durationMeta = document.querySelector('meta[name="duration"]');
    if (durationMeta) {
      // Get original value (from data-base or from content)
      const original = parseInt(durationMeta.getAttribute('data-base') || durationMeta.content, 10);

      // Store original value if it's not already stored
      if (!durationMeta.hasAttribute('data-base')) {
        durationMeta.setAttribute('data-base', original);
      }

      // Apply scaled value
      const scaled = Math.round(original * scale);
      durationMeta.setAttribute('content', scaled.toString());
    }
  });
  function setDirectionByPosition(ach, posString) {
    const raw = String(posString || '')
      .trim()
      .toLowerCase();
    // normalize: allow tokens in any order: "left-top", "top_left", "center right", etc.
    const tokens = raw
      .replace(/[^a-z]+/g, ' ')
      .trim()
      .split(/\s+/);
    console.log(`Parsing position string: "${raw}", tokens: [${tokens.join(', ')}]`);
    const hasLeft = tokens.includes('left');
    const hasRight = tokens.includes('right');
    const hasTop = tokens.includes('top');
    const hasBottom = tokens.includes('bottom') || tokens.includes('bot');
    const hasCenter = tokens.includes('center') || tokens.includes('middle') || tokens.includes('mid');

    const atLeft = hasLeft && !hasRight;
    const atRight = hasRight && !hasLeft;
    const atCenter = (!atLeft && !atRight) || hasCenter; // default center when ambiguous
    const fromTop = hasTop && !hasBottom;
    const fromBottom = hasBottom && !fromTop; // default bottom when ambiguous

    ach.className = 'ach';
    ach.classList.add(fromTop ? 'from-top' : 'from-bottom');
    ach.classList.add(atLeft ? 'at-left' : atRight ? 'at-right' : 'at-center');
    console.log(`Position parsed: ${atLeft ? 'left' : atRight ? 'right' : 'center'} / ${fromTop ? 'top' : 'bottom'}`);
    const inner = ach.querySelector('.ach-inner');
    if (inner) {
      inner.classList.remove('side-left', 'side-right', 'side-up', 'side-down');
      inner.style.setProperty('--start-x', atLeft ? '-130%' : atRight ? '130%' : '0');
      inner.style.setProperty('--start-y', fromTop ? '-130%' : fromBottom ? '130%' : '0');
      inner.style.setProperty('--overshoot-x', atLeft ? '10%' : atRight ? '-10%' : '0');
      inner.style.setProperty('--overshoot-y', fromTop ? '10%' : fromBottom ? '-10%' : '0');
      inner.style.setProperty('--end-x', atLeft ? '-130%' : atRight ? '130%' : '0');
      inner.style.setProperty('--end-y', fromTop ? '-130%' : fromBottom ? '130%' : '0');
    }
  }

  window.api.onNotification((notificationData) => {
    if (notificationData && notificationData.displayName && notificationData.iconPath) {
      document.querySelector('.title').textContent = notificationData.displayName;
      document.querySelector('.detail').textContent = notificationData.description || '';
      document.querySelector('.icon img').src = notificationData.iconPath;
    }

    const container = document.querySelector('.ach');
    container?.style?.setProperty('--scale', String(notificationData.scale || 1));
    void container.offsetWidth;
    //setDirectionByPosition(container, notificationData.position);
    void container.offsetWidth;
    container.classList.add('active');

    // Read duration from <meta name="duration">
    const durationMeta = document.querySelector('meta[name="duration"]');
    const duration = parseInt(durationMeta?.content, 10) || 4000;
    setTimeout(() => {
      container.classList.remove('active');
      window.api.closeNotificationWindow();
    }, duration * notificationData.duration);
  });
});
