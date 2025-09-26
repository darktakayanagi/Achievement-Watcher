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

  window.api.onNotification((notificationData) => {
    if (notificationData && notificationData.displayName && notificationData.iconPath) {
      document.querySelector('.title').textContent = notificationData.displayName;
      document.querySelector('.detail').textContent = notificationData.description || '';
      document.querySelector('.icon img').src = notificationData.iconPath;
    }
    const container = document.querySelector('.ach');
    container.classList.add('active');

    // Read duration from <meta name="duration">
    const durationMeta = document.querySelector('meta[name="duration"]');
    const duration = parseInt(durationMeta?.content, 10) || 4000;
    setTimeout(() => {
      window.api.captureScreen();
    }, duration * 0.75);
    setTimeout(() => {
      container.classList.remove('active');
      window.api.closeNotificationWindow();
    }, duration);
  });
});
