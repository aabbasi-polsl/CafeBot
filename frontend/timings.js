(() => {
  const list = document.querySelector('#hours-list');
  if (!list) return;

  const showMessage = message => {
    const state = document.createElement('p');
    state.className = 'hours-state';
    state.textContent = message;
    list.replaceChildren(state);
    list.setAttribute('aria-busy', 'false');
  };

  fetch('/data/timings.json')
    .then(response => {
      if (!response.ok) throw new Error(`Opening hours request failed: ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (!Array.isArray(data.hours) || data.hours.some(entry =>
        !entry || typeof entry.days !== 'string' || typeof entry.open !== 'string' || typeof entry.close !== 'string'
      )) throw new Error('Opening hours data has an invalid format.');

      const rows = data.hours.map(entry => {
        const row = document.createElement('div');
        row.className = 'hours-row';
        const days = document.createElement('span');
        days.textContent = entry.days;
        const time = document.createElement('strong');
        time.textContent = `${entry.open}–${entry.close}`;
        row.append(days, time);
        return row;
      });

      list.replaceChildren(...rows);
      list.setAttribute('aria-busy', 'false');
    })
    .catch(() => showMessage('Opening hours are unavailable right now. Please check back soon.'));
})();
