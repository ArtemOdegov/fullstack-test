import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import clsx from 'clsx';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api/client';
import { usePaginatedItems } from './hooks/usePaginatedItems';
import './App.css';

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message);
      if (parsed?.message) {
        return parsed.message as string;
      }
    } catch {
      void 0;
    }
    return error.message;
  }
  return 'Неизвестная ошибка';
};

const parseIds = (value: string): number[] => {
  return value
    .split(/[^0-9]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => Number(chunk))
    .filter((id) => Number.isInteger(id) && id > 0);
};

type SortableRowProps = {
  id: number;
  onRemove: (id: number) => void;
  disabled?: boolean;
};

const SortableRow = ({ id, onRemove, disabled }: SortableRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style} className={clsx('item-row', 'item-row--sortable', { 'item-row--dragging': isDragging })}>
      <button type="button" className="item-row__drag" {...attributes} {...listeners} disabled={disabled}>
        ⋮
      </button>
      <span className="item-row__id">#{id}</span>
      <button
        type="button"
        className="item-row__action item-row__action--danger"
        onClick={() => onRemove(id)}
        disabled={disabled}
      >
        Удалить
      </button>
    </div>
  );
};

const useInfiniteTrigger = (loadMore: () => void, enabled: boolean) => {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadRef = useRef(loadMore);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    loadRef.current = loadMore;
  }, [loadMore]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled && observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
  }, [enabled]);

  useEffect(
    () => () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    },
    []
  );

  return useCallback((node: Element | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) {
      return;
    }
    observerRef.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && enabledRef.current) {
          loadRef.current();
        }
      },
      {
        rootMargin: '100px',
        threshold: 0.1,
      }
    );
    observerRef.current.observe(node);
  }, []);
};

function App() {
  const unselected = usePaginatedItems(api.loadUnselected);
  const selected = usePaginatedItems(api.loadSelected);

  const [addInput, setAddInput] = useState('');
  const [addStatus, setAddStatus] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle');
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [pendingSelectIds, setPendingSelectIds] = useState<Set<number>>(new Set());
  const [pendingUnselectIds, setPendingUnselectIds] = useState<Set<number>>(new Set());
  const [sortMessage, setSortMessage] = useState<string | null>(null);
  const [sortStatus, setSortStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const sortTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (sortTimerRef.current) {
        clearTimeout(sortTimerRef.current);
      }
    },
    []
  );

  const leftSentinelRef = useInfiniteTrigger(
    () => {
      if (!unselected.isInitialLoading) {
        void unselected.loadMore();
      }
    },
    unselected.hasMore && !unselected.isInitialLoading
  );

  const rightSentinelRef = useInfiniteTrigger(
    () => {
      if (!selected.isInitialLoading) {
        void selected.loadMore();
      }
    },
    selected.hasMore && !selected.isInitialLoading
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  const handleAddSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ids = Array.from(new Set(parseIds(addInput)));
    if (!ids.length) {
      setAddStatus('error');
      setAddMessage('Введите хотя бы один корректный ID');
      return;
    }
    setAddStatus('pending');
    setAddMessage('Запрос отправлен, применение может занять до 10 секунд');
    try {
      await api.addIds(ids);
      setAddStatus('ok');
      setAddMessage(`Добавлено ${ids.length} ID`);
      setAddInput('');
      unselected.refresh();
    } catch (error) {
      setAddStatus('error');
      setAddMessage(formatError(error));
    }
  };

  const mutateSet = (updater: (prev: Set<number>) => void) => {
    return (prev: Set<number>) => {
      const next = new Set(prev);
      updater(next);
      return next;
    };
  };

  const handleSelect = async (id: number) => {
    setPendingSelectIds(mutateSet((next) => next.add(id)));
    try {
      await api.select([id]);
      unselected.refresh();
      selected.refresh();
    } catch (error) {
      setAddStatus('error');
      setAddMessage(formatError(error));
    } finally {
      setPendingSelectIds(mutateSet((next) => next.delete(id)));
    }
  };

  const handleUnselect = async (id: number) => {
    setPendingUnselectIds(mutateSet((next) => next.add(id)));
    try {
      await api.unselect([id]);
      unselected.refresh();
      selected.refresh();
    } catch (error) {
      setSortStatus('error');
      setSortMessage(formatError(error));
    } finally {
      setPendingUnselectIds(mutateSet((next) => next.delete(id)));
    }
  };

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (sortStatus === 'pending') {
        return;
      }
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const activeId = Number(active.id);
      const overId = Number(over.id);
      const from = selected.items.findIndex((value) => value === activeId);
      const to = selected.items.findIndex((value) => value === overId);
      if (from === -1 || to === -1) {
        return;
      }

      const reordered = arrayMove(selected.items, from, to);
      selected.updateItems(() => reordered);
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      const windowSlice = reordered.slice(start, end + 1);

      if (sortTimerRef.current) {
        clearTimeout(sortTimerRef.current);
        sortTimerRef.current = null;
      }
      setSortStatus('pending');
      setSortMessage('Сохраняем порядок...');
      try {
        await api.reorder({
          ids: windowSlice,
          offset: start,
          search: selected.search,
        });
        setSortStatus('success');
        setSortMessage('Порядок сохранён');
      } catch (error) {
        setSortStatus('error');
        setSortMessage(formatError(error));
        selected.refresh();
      } finally {
        sortTimerRef.current = window.setTimeout(() => {
          setSortMessage(null);
          setSortStatus('idle');
          sortTimerRef.current = null;
        }, 2000);
      }
    },
    [selected, sortStatus]
  );

  const leftHelper = useMemo(() => {
    if (unselected.isInitialLoading) {
      return 'Загружаем первые 20 элементов...';
    }
    if (unselected.error) {
      return unselected.error;
    }
    if (!unselected.items.length) {
      return 'Совпадений не найдено';
    }
    return null;
  }, [unselected.error, unselected.isInitialLoading, unselected.items.length]);

  const rightHelper = useMemo(() => {
    if (selected.isInitialLoading) {
      return 'Загружаем выбранные элементы...';
    }
    if (selected.error) {
      return selected.error;
    }
    if (!selected.items.length) {
      return 'Пока ничего не выбрано';
    }
    return null;
  }, [selected.error, selected.isInitialLoading, selected.items.length]);

  return (
    <div className="app">
      <header className="app__header">
      <div>
          <h1>Менеджер ID</h1>
          <p>1 000 000 базовых элементов + пользовательские значения.</p>
        </div>
        <span className="app__badge">Запросы пакуются автоматически</span>
      </header>

      <main className="app__content">
        <section className="pane">
          <div className="pane__header">
            <h2>Доступные элементы</h2>
            <span>Левая колонка показывает все ID кроме выбранных</span>
      </div>

          <label className="field">
            <span className="field__label">Поиск по ID</span>
            <input
              type="search"
              value={unselected.search}
              onChange={(event) => unselected.setSearch(event.target.value)}
              placeholder="Например: 42 или 00042"
            />
          </label>

          <form className="add-form" onSubmit={handleAddSubmit}>
            <label className="field">
              <span className="field__label">Добавление новых ID</span>
              <input
                type="text"
                value={addInput}
                onChange={(event) => setAddInput(event.target.value)}
                placeholder="ID или несколько через запятую / пробел"
                disabled={addStatus === 'pending'}
              />
            </label>
            <button type="submit" disabled={addStatus === 'pending'}>
              {addStatus === 'pending' ? 'Отправляем...' : 'Добавить'}
        </button>
          </form>
          {addMessage && (
            <p className={clsx('hint', { 'hint--error': addStatus === 'error', 'hint--success': addStatus === 'ok' })}>
              {addMessage}
            </p>
          )}

          <div className="list">
            {leftHelper && <div className="list__state">{leftHelper}</div>}
            {unselected.items.map((id) => {
              const pending = pendingSelectIds.has(id);
              return (
                <div key={id} className="item-row">
                  <span className="item-row__id">#{id}</span>
                  <button type="button" className="item-row__action" onClick={() => handleSelect(id)} disabled={pending}>
                    {pending ? 'В работе...' : 'Выбрать'}
                  </button>
                </div>
              );
            })}
            <div key={unselected.items.length} ref={leftSentinelRef} className="list__sentinel">
              {unselected.isAppending
                ? 'Загружаем ещё...'
                : unselected.hasMore
                  ? 'Прокрутите ниже, чтобы загрузить ещё'
                  : 'Вы достигли конца списка'}
            </div>
          </div>
        </section>

        <section className="pane">
          <div className="pane__header">
            <h2>Выбранные элементы</h2>
            <span>Drag&Drop сохраняет порядок на сервере</span>
      </div>

          <label className="field">
            <span className="field__label">Поиск по ID</span>
            <input
              type="search"
              value={selected.search}
              onChange={(event) => selected.setSearch(event.target.value)}
              placeholder="Например: 77"
            />
          </label>

          {sortMessage && (
            <p
              className={clsx('hint', {
                'hint--pending': sortStatus === 'pending',
                'hint--success': sortStatus === 'success',
                'hint--error': sortStatus === 'error',
              })}
            >
              {sortMessage}
            </p>
          )}

          <div className="list">
            {rightHelper && <div className="list__state">{rightHelper}</div>}
            {selected.items.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={selected.items} strategy={verticalListSortingStrategy}>
                  {selected.items.map((id) => (
                    <SortableRow key={id} id={id} onRemove={handleUnselect} disabled={pendingUnselectIds.has(id)} />
                  ))}
                </SortableContext>
              </DndContext>
            )}
            <div key={selected.items.length} ref={rightSentinelRef} className="list__sentinel">
              {selected.isAppending
                ? 'Загружаем ещё...'
                : selected.hasMore
                  ? 'Прокрутите ниже, чтобы загрузить ещё'
                  : 'Это все выбранные элементы'}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
