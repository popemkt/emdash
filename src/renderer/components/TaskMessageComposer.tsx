import React from 'react';
import { CornerDownLeft } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export interface TaskMessageComposerModeOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  submitTitle: string;
  submitAriaLabel: string;
  mode?: {
    value: string;
    onChange: (value: string) => void;
    options: TaskMessageComposerModeOption[];
  };
}

const TaskMessageComposer: React.FC<Props> = ({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  disabled = false,
  submitTitle,
  submitAriaLabel,
  mode,
}) => {
  const canSubmit = value.trim().length > 0 && !disabled;

  return (
    <div className="relative rounded-md border border-border bg-white shadow-lg dark:border-border dark:bg-card">
      <div className="flex items-center gap-2 rounded-md px-4 py-3">
        {mode ? (
          <Select value={mode.value} onValueChange={mode.onChange}>
            <SelectTrigger className="h-9 w-[180px] border-border bg-muted text-xs dark:border-border dark:bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" className="z-[120]">
              {mode.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Input
          className="h-9 flex-1 border-border bg-muted dark:border-border dark:bg-muted"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canSubmit) {
                onSubmit();
              }
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-9 border border-border bg-muted px-3 text-xs font-medium hover:bg-muted dark:border-border dark:bg-muted dark:hover:bg-muted"
          onClick={onSubmit}
          disabled={!canSubmit}
          title={submitTitle}
          aria-label={submitAriaLabel}
        >
          <CornerDownLeft className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default TaskMessageComposer;
