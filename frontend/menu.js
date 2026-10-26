(() => {
  const menuGrid = document.querySelector('#menu-items');
  const filters = document.querySelector('#menu-filters');
  const note = document.querySelector('#menu-note');
  if (!menuGrid || !filters || !note) return;

  const money = (amount, currency) => new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount);

  const makeText = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    return element;
  };

  function showItems(items, category, currency) {
    menuGrid.replaceChildren();
    const visibleItems = items.filter(item => item.available && (category === 'all' || item.category === category));

    if (!visibleItems.length) {
      menuGrid.append(makeText('p', 'menu-state', 'There are no available items in this category right now.'));
      return;
    }

    visibleItems.forEach(item => {
      const card = makeText('article', 'menu-card', '');
      const top = makeText('div', 'menu-card-top', '');
      top.append(
        makeText('p', 'card-label', item.category),
        makeText('span', 'menu-price', money(item.price_pln, currency)),
      );
      card.append(top, makeText('h3', '', item.name), makeText('p', 'menu-card-description', item.description));

      if (Array.isArray(item.sizes) && item.sizes.length > 0) {
        const sizeNames = item.sizes.map(size => size.name).filter(Boolean);
        if (sizeNames.length) card.append(makeText('p', 'menu-card-sizes', `Sizes: ${sizeNames.join(' · ')}`));
      }
      menuGrid.append(card);
    });
  }

  function showError() {
    filters.replaceChildren();
    menuGrid.setAttribute('aria-busy', 'false');
    menuGrid.replaceChildren(makeText('p', 'menu-state', 'Sorry, the menu is unavailable right now. Please try again in a moment.'));
  }

  fetch('/data/menu.json')
    .then(response => {
      if (!response.ok) throw new Error(`Menu request failed: ${response.status}`);
      return response.json();
    })
    .then(menu => {
      const items = Array.isArray(menu.items) ? menu.items : [];
      const availableItems = items.filter(item => item && item.available === true);
      const categories = [...new Set(availableItems.map(item => item.category).filter(Boolean))];
      const currency = typeof menu.currency === 'string' ? menu.currency : 'PLN';
      let selectedCategory = 'all';

      const addFilter = (label, category) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu-filter';
        button.textContent = label;
        button.setAttribute('aria-pressed', String(category === selectedCategory));
        button.addEventListener('click', () => {
          selectedCategory = category;
          filters.querySelectorAll('button').forEach(filter => {
            filter.setAttribute('aria-pressed', String(filter === button));
          });
          showItems(availableItems, selectedCategory, currency);
        });
        filters.append(button);
      };

      filters.replaceChildren();
      addFilter('All items', 'all');
      categories.forEach(category => addFilter(category, category));
      showItems(availableItems, selectedCategory, currency);

      if (menu.notice) note.textContent = `${menu.notice} Prices shown in ${currency}.`;
      else note.textContent = `Prices shown in ${currency}. Ask CafeBot about menu details.`;
      menuGrid.setAttribute('aria-busy', 'false');
    })
    .catch(showError);
})();
