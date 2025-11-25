const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;
const BASE_MAX_ID = 1_000_000;
const PAGE_LIMIT = 20;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const selectedOrder = [];
const selectedSet = new Set();
const extraIds = [];
const extraSet = new Set();

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isBaseId = (id) => isPositiveInteger(id) && id <= BASE_MAX_ID;
const idExists = (id) => isBaseId(id) || extraSet.has(id);

const insertExtraId = (id) => {
  if (extraSet.has(id)) {
    return;
  }

  let left = 0;
  let right = extraIds.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (extraIds[mid] < id) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  extraIds.splice(left, 0, id);
  extraSet.add(id);
};

function* iterateAllIds() {
  let extraIndex = 0;
  for (let baseId = 1; baseId <= BASE_MAX_ID; baseId += 1) {
    while (extraIndex < extraIds.length && extraIds[extraIndex] < baseId) {
      yield extraIds[extraIndex];
      extraIndex += 1;
    }
    yield baseId;
  }

  while (extraIndex < extraIds.length) {
    yield extraIds[extraIndex];
    extraIndex += 1;
  }
}

const parsePagination = (query) => {
  const limit = Math.min(Number(query.limit) || PAGE_LIMIT, PAGE_LIMIT);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const search = (query.search || '').trim();
  return { limit, offset, search };
};

const findPagedUnselected = ({ limit, offset, search }) => {
  const normalizedSearch = search ? search.toLowerCase() : '';
  const result = [];
  let skipped = 0;
  let hasMore = false;

  for (const id of iterateAllIds()) {
    if (selectedSet.has(id)) {
      continue;
    }

    if (normalizedSearch && !id.toString().toLowerCase().includes(normalizedSearch)) {
      continue;
    }

    if (skipped < offset) {
      skipped += 1;
      continue;
    }

    if (result.length < limit) {
      result.push(id);
    } else {
      hasMore = true;
      break;
    }
  }

  return { items: result, hasMore };
};

const findPagedSelected = ({ limit, offset, search }) => {
  const normalizedSearch = search ? search.toLowerCase() : '';
  const filtered = normalizedSearch
    ? selectedOrder.filter((id) => id.toString().toLowerCase().includes(normalizedSearch))
    : [...selectedOrder];

  const slice = filtered.slice(offset, offset + limit);
  const hasMore = offset + slice.length < filtered.length;
  return { items: slice, hasMore };
};

app.get('/api/items/unselected', (req, res) => {
  const page = parsePagination(req.query);
  const payload = findPagedUnselected(page);
  res.json(payload);
});

app.get('/api/items/selected', (req, res) => {
  const page = parsePagination(req.query);
  const payload = findPagedSelected(page);
  res.json(payload);
});

app.post('/api/items/add', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) {
    return res.status(400).json({ message: 'Не переданы идентификаторы' });
  }

  const prepared = ids.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  const invalid = prepared.filter((id) => !isPositiveInteger(id));

  if (invalid.length) {
    return res.status(400).json({ message: 'Все ID должны быть положительными целыми числами' });
  }

  const duplicates = prepared.filter((id) => idExists(id));
  if (duplicates.length) {
    return res.status(409).json({ message: 'Некоторые ID уже существуют', duplicates });
  }

  prepared.forEach((id) => {
    if (!isBaseId(id)) {
      insertExtraId(id);
    }
  });

  res.json({ added: prepared });
});

app.post('/api/items/select', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (!ids.length) {
    return res.status(400).json({ message: 'Не переданы идентификаторы' });
  }

  const nonexistent = ids.filter((id) => !idExists(id));
  if (nonexistent.length) {
    return res.status(404).json({ message: 'Некоторые ID отсутствуют', nonexistent });
  }

  const added = [];
  ids.forEach((id) => {
    if (!selectedSet.has(id)) {
      selectedOrder.push(id);
      selectedSet.add(id);
      added.push(id);
    }
  });

  res.json({ selected: selectedOrder, added });
});

app.post('/api/items/unselect', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (!ids.length) {
    return res.status(400).json({ message: 'Не переданы идентификаторы' });
  }

  const toRemove = new Set(ids);
  if (!ids.every((id) => selectedSet.has(id))) {
    return res.status(404).json({ message: 'Некоторые ID не находятся в списке выбранных' });
  }

  const nextOrder = selectedOrder.filter((id) => !toRemove.has(id));
  selectedOrder.length = 0;
  selectedOrder.push(...nextOrder);
  ids.forEach((id) => selectedSet.delete(id));

  res.json({ selected: selectedOrder });
});

app.post('/api/items/reorder', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  const offset = Math.max(Number(req.body.offset) || 0, 0);
  const search = (req.body.search || '').toString().trim();

  if (!ids.length) {
    return res.status(400).json({ message: 'Не переданы идентификаторы' });
  }

  const duplicates = new Set(ids);
  if (duplicates.size !== ids.length) {
    return res.status(400).json({ message: 'Список содержит дубли' });
  }

  if (!ids.every((id) => selectedSet.has(id))) {
    return res.status(400).json({ message: 'Список должен содержать только выбранные ID' });
  }

  const normalizedSearch = search.toLowerCase();
  const filtered = normalizedSearch
    ? selectedOrder.filter((id) => id.toString().toLowerCase().includes(normalizedSearch))
    : [...selectedOrder];

  if (offset + ids.length > filtered.length) {
    return res.status(400).json({ message: 'Некорректные параметры окна сортировки' });
  }

  const currentWindow = filtered.slice(offset, offset + ids.length);
  const windowSet = new Set(currentWindow);
  const isValidWindow = ids.every((id) => windowSet.has(id));
  if (!isValidWindow) {
    return res.status(400).json({ message: 'Окно сортировки не соответствует текущим данным' });
  }

  filtered.splice(offset, ids.length, ...ids);

  const filteredSet = new Set(filtered);
  let filteredIndex = 0;
  for (let i = 0; i < selectedOrder.length; i += 1) {
    if (!filteredSet.has(selectedOrder[i])) {
      continue;
    }
    selectedOrder[i] = filtered[filteredIndex];
    filteredIndex += 1;
  }

  res.json({ selected: selectedOrder });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
