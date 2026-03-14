'use client';

import type { LucideIcon } from 'lucide-react';
import { Button } from './Button';

export interface TabItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

interface TabNavProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (id: string) => void;
}

export function TabNav({ tabs, activeTab, onChange }: TabNavProps) {
  return (
    <div className="px-4 md:px-8 border-b" style={{ borderColor: 'var(--color-border)' }}>
      <nav className="flex gap-1 overflow-x-auto scrollbar-hide -mb-px">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Button
              key={tab.id}
              variant="ghost"
              onClick={() => onChange(tab.id)}
              className={[
                '!px-4 !py-3 !text-sm !rounded-none whitespace-nowrap hover:!bg-transparent border-b-2',
                isActive
                  ? 'border-[var(--color-primary)] !text-[var(--color-primary)]'
                  : 'border-transparent !text-[var(--color-text-muted)] hover:!text-[var(--color-text-secondary)] hover:border-[var(--color-border)]',
              ].join(' ')}
            >
              {tab.icon && <tab.icon className="w-4 h-4" />}
              <span>{tab.label}</span>
            </Button>
          );
        })}
      </nav>
    </div>
  );
}
