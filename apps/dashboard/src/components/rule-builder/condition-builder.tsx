"use client";

import { Button, cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { DesignInput, DesignSelectorDropdown } from "@/components/design-components";
import {
  type ConditionNode,
  createEmptyCondition,
  createEmptyGroup,
  type GroupNode,
  type RuleNode,
} from "@/lib/cel-visual-parser";
import { MinusIcon, PlusIcon, TrashIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { CountryCodeInput } from "@/components/country-code-select";
import { normalizeCountryCode } from "@hexclave/shared/dist/schema-fields";
import { validateCountryCode } from "@hexclave/shared/dist/utils/country-codes";
import { type ConditionField, type ConditionOperator, conditionFields, fieldMetadata, getOperatorsForField, isNumericField, validateNumericFieldValue } from "@hexclave/shared/dist/utils/cel-fields";
import React from "react";

const conditionRowSurfaceClass =
  "bg-white/90 dark:bg-background/60 shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.06]";
const conditionFieldClass = "h-8 min-w-[120px]";
const conditionValueClass = "h-8 w-full";

const UNSET_SELECT_VALUE = "__unset__";

/**
 * Validates whether a string is a valid regular expression.
 * Returns null if valid, or an error message if invalid.
 */
function validateRegex(pattern: string): string | null {
  if (!pattern.trim()) {
    return "Regex pattern cannot be empty";
  }
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) {
      return e.message;
    }
    return "Invalid regex pattern";
  }
}

const validateCountryCodeValue = validateCountryCode;

/**
 * Recursively checks if a RuleNode tree has any validation errors.
 * Returns true if the tree is valid, false if there are errors.
 */
export function isConditionTreeValid(node: RuleNode): boolean {
  if (node.type === 'condition') {
    if (node.field === 'countryCode') {
      const countryCodeError = validateCountryCodeValue(
        Array.isArray(node.value)
          ? node.value
          : String(node.value),
      );
      if (countryCodeError !== null) {
        return false;
      }
    }
    // Check regex validation
    if (node.operator === 'matches') {
      const error = validateRegex(String(node.value));
      if (error !== null) {
        return false;
      }
    }
    // Validate numeric fields are integers within [0, 100]
    if (isNumericField(node.field)) {
      if (validateNumericFieldValue(node.field, String(node.value)) !== null) {
        return false;
      }
    }
    return true;
  }

  // Group node - check all children
  return node.children.every(child => isConditionTreeValid(child));
}

// Field options derived from shared metadata
const FIELD_OPTIONS: { value: ConditionField, label: string }[] = conditionFields.map(f => ({
  value: f,
  label: fieldMetadata[f].label,
}));

// Operator labels for display
const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  greater_than: 'is greater than',
  greater_or_equal: 'is greater than or equal',
  less_than: 'is less than',
  less_or_equal: 'is less than or equal',
  contains: 'contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  matches: 'matches regex',
  in_list: 'is one of',
};

// Chip input for "is one of" values
function ChipsInput({
  values,
  onChange,
  placeholder,
  className,
}: {
  values: string[],
  onChange: (values: string[]) => void,
  placeholder?: string,
  className?: string,
}) {
  const [inputValue, setInputValue] = React.useState("");

  const commitValue = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitValue(inputValue);
      setInputValue("");
    } else if (e.key === 'Backspace' && inputValue === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (pasted.includes(',')) {
      e.preventDefault();
      const combined = inputValue + pasted;
      const items = combined.split(',').map(s => s.trim()).filter(Boolean);
      const uniqueNew = items.filter(item => !values.includes(item));
      if (uniqueNew.length > 0) {
        onChange([...values, ...uniqueNew]);
      }
      setInputValue("");
    }
  };

  const removeChip = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 px-2 py-1 min-h-8 w-full rounded-md border border-input bg-transparent text-sm focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    >
      {values.map((chip, index) => (
        <span
          key={`${chip}-${index}`}
          className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground"
        >
          {chip}
          <button
            type="button"
            onClick={() => removeChip(index)}
            aria-label={`Remove ${chip}`}
            className="rounded-full p-0.5 hover:bg-secondary-foreground/20 transition-colors hover:transition-none"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => {
          commitValue(inputValue);
          setInputValue("");
        }}
        placeholder={values.length === 0 ? placeholder : undefined}
        className="flex-1 min-w-[80px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
      />
    </div>
  );
}

// Single condition row component
function ConditionRow({
  condition,
  onChange,
  onRemove,
  showRemove,
}: {
  condition: ConditionNode,
  onChange: (updated: ConditionNode) => void,
  onRemove: () => void,
  showRemove: boolean,
}) {
  const availableOperators = getOperatorsForField(condition.field);
  const predefinedValues = fieldMetadata[condition.field].predefinedValues;
  const isCountryCodeField = condition.field === 'countryCode';
  const isCountryCodeListOperator = isCountryCodeField && condition.operator === 'in_list';
  const countryCodeListValues = isCountryCodeListOperator
    ? Array.isArray(condition.value)
      ? condition.value
      : []
    : [];
  const countryCodeError = isCountryCodeField
    ? validateCountryCodeValue(
        Array.isArray(condition.value)
          ? condition.value
          : String(condition.value),
    )
    : null;

  // Validate regex when operator is 'matches'
  const regexError = condition.operator === 'matches'
    ? validateRegex(String(condition.value))
    : null;

  const handleFieldChange = (field: ConditionField) => {
    const newOperators = getOperatorsForField(field);
    const operator = newOperators.includes(condition.operator) ? condition.operator : newOperators[0];

    // Reset value - use array for in_list, string otherwise
    const value: string | number | string[] = operator === 'in_list'
      ? []
      : isNumericField(field)
        ? 0
        : '';

    onChange({ ...condition, field, operator, value });
  };

  const handleOperatorChange = (operator: ConditionOperator) => {
    let value = condition.value;
    if (operator === 'in_list' && !Array.isArray(value)) {
      value = value ? [String(value)] : [];
    } else if (operator !== 'in_list' && Array.isArray(value)) {
      value = value[0] ?? '';
    }
    onChange({ ...condition, operator, value });
  };

  const handleValueChange = (value: string | number | string[]) => {
    if (!isCountryCodeField) {
      onChange({ ...condition, value });
      return;
    }

    if (Array.isArray(value)) {
      onChange({ ...condition, value: value.map(normalizeCountryCode) });
      return;
    }

    if (typeof value === 'string') {
      onChange({ ...condition, value: normalizeCountryCode(value) });
      return;
    }

    onChange({ ...condition, value });
  };

  const handleCountryCodeListItemChange = (index: number, value: string) => {
    handleValueChange(countryCodeListValues.map((item, itemIndex) => itemIndex === index ? value : item));
  };

  const handleAddCountryCodeListItem = () => {
    handleValueChange([...countryCodeListValues, '']);
  };

  const handleRemoveCountryCodeListItem = (index: number) => {
    handleValueChange(countryCodeListValues.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <div className={cn("flex items-center gap-2 p-2 rounded-lg", conditionRowSurfaceClass)}>
      <DesignSelectorDropdown
        value={condition.field}
        onValueChange={(value) => handleFieldChange(value as ConditionField)}
        options={FIELD_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
        size="sm"
        className={conditionFieldClass}
        triggerClassName={conditionFieldClass}
      />

      <DesignSelectorDropdown
        value={condition.operator}
        onValueChange={(value) => handleOperatorChange(value as ConditionOperator)}
        options={availableOperators.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
        size="sm"
        className={conditionFieldClass}
        triggerClassName={conditionFieldClass}
      />

      {/* Value input */}
      <div className="flex-1 min-w-0 space-y-1">
        {isCountryCodeListOperator ? (
          <div className="space-y-2">
            {countryCodeListValues.map((countryCode, index) => (
              <div key={`${condition.id}-${index}`} className="flex items-center gap-2">
                <CountryCodeInput
                  value={countryCode || null}
                  onChange={(val) => handleCountryCodeListItemChange(index, val ?? "")}
                  className={cn(
                    conditionValueClass,
                    countryCodeError !== null && "border-destructive ring-1 ring-destructive/30",
                  )}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove country code ${index + 1}`}
                  title="Remove country code"
                  onClick={() => handleRemoveCountryCodeListItem(index)}
                >
                  <MinusIcon className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted-foreground hover:text-foreground"
              aria-label="Add country code"
              title="Add country code"
              onClick={handleAddCountryCodeListItem}
            >
              <PlusIcon className="h-4 w-4" />
            </Button>
          </div>
        ) : condition.operator === 'in_list' ? (
          <ChipsInput
            values={Array.isArray(condition.value) ? condition.value : []}
            onChange={(items) => handleValueChange(items)}
            placeholder="Type a value and press Enter or comma to add"
            className={cn(
              countryCodeError !== null
                ? "border-destructive ring-1 ring-destructive/30"
                : undefined,
            )}
          />
        ) : isCountryCodeField ? (
          <CountryCodeInput
            value={typeof condition.value === 'string' && condition.value ? condition.value : null}
            onChange={(val) => handleValueChange(val ?? "")}
            className={cn(
              conditionValueClass,
              countryCodeError !== null && "border-destructive ring-1 ring-destructive/30",
            )}
          />
        ) : predefinedValues ? (
          <DesignSelectorDropdown
            value={String(condition.value) || UNSET_SELECT_VALUE}
            onValueChange={(value) => handleValueChange(value === UNSET_SELECT_VALUE ? "" : value)}
            options={[
              { value: UNSET_SELECT_VALUE, label: "Select..." },
              ...predefinedValues.map((val) => ({ value: val, label: val })),
            ]}
            size="sm"
            className="w-full"
            triggerClassName={conditionValueClass}
          />
        ) : isNumericField(condition.field) ? (
          <DesignInput
            type="number"
            size="sm"
            min={0}
            max={100}
            step={1}
            value={String(condition.value)}
            onChange={(e) => handleValueChange(e.target.value === '' ? 0 : Number(e.target.value))}
            placeholder="0-100"
            className={conditionValueClass}
          />
        ) : (
          <div className="flex items-center gap-1">
            <DesignInput
              type="text"
              size="sm"
              value={String(condition.value)}
              onChange={(e) => handleValueChange(e.target.value)}
              placeholder={
                condition.operator === 'matches'
                  ? "Enter regex pattern..."
                  : "Enter value..."
              }
              className={cn(
                conditionValueClass,
                regexError !== null || countryCodeError !== null
                  ? "border-destructive ring-1 ring-destructive/30"
                  : undefined,
              )}
            />
            {(regexError !== null || countryCodeError !== null) && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-destructive flex-shrink-0">
                      <WarningCircleIcon className="h-4 w-4" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[300px]">
                    <p className="text-xs">{regexError ?? countryCodeError}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        )}
        {isCountryCodeField && (
          <>
            <p className="text-[10px] text-muted-foreground">
              {isCountryCodeListOperator
                ? "Add one or more 2-letter country codes"
                : "2-letter country code, e.g. US"}
            </p>
            {countryCodeError !== null && (
              <p className="text-[10px] text-destructive">
                {countryCodeError}
              </p>
            )}
          </>
        )}
      </div>

      {/* Remove button */}
      {showRemove && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          aria-label="Remove condition"
          title="Remove condition"
          onClick={onRemove}
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// Condition group component (AND/OR)
function ConditionGroup({
  group,
  onChange,
  onRemove,
  depth = 0,
  showRemove,
}: {
  group: GroupNode,
  onChange: (updated: GroupNode) => void,
  onRemove?: () => void,
  depth?: number,
  showRemove?: boolean,
}) {
  const handleChildChange = (index: number, updated: RuleNode) => {
    const newChildren = [...group.children];
    newChildren[index] = updated;
    onChange({ ...group, children: newChildren });
  };

  const handleRemoveChild = (index: number) => {
    const newChildren = group.children.filter((_, i) => i !== index);
    onChange({ ...group, children: newChildren });
  };

  const handleAddCondition = () => {
    onChange({
      ...group,
      children: [...group.children, createEmptyCondition()],
    });
  };

  const handleAddGroup = () => {
    const newGroup = createEmptyGroup(group.operator === 'and' ? 'or' : 'and');
    newGroup.children = [createEmptyCondition()];
    onChange({
      ...group,
      children: [...group.children, newGroup],
    });
  };

  const handleOperatorToggle = () => {
    onChange({
      ...group,
      operator: group.operator === 'and' ? 'or' : 'and',
    });
  };

  const isRoot = depth === 0;

  return (
    <div className={cn(
      "space-y-2",
      !isRoot && "p-3 rounded-lg ring-1",
      !isRoot && group.operator === 'and' && "bg-blue-500/5 ring-blue-500/10",
      !isRoot && group.operator === 'or' && "bg-amber-500/5 ring-amber-500/10",
    )}>
      {/* Group header */}
      <div className="flex items-center gap-2">
        {!isRoot && showRemove && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
            aria-label="Remove group"
            title="Remove group"
            onClick={onRemove}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        )}
        <button
          onClick={handleOperatorToggle}
          className={cn(
            "text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded",
            "transition-colors duration-150 hover:transition-none cursor-pointer",
            group.operator === 'and' && "bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20",
            group.operator === 'or' && "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20",
          )}
        >
          {group.operator.toUpperCase()}
        </button>
        <span className="text-xs text-muted-foreground">
          {group.operator === 'and' ? 'Match all conditions' : 'Match any condition'}
        </span>
      </div>

      {/* Children */}
      <div className="space-y-2 pl-2 border-l-2 border-foreground/[0.06]">
        {group.children.map((child, index) => (
          <React.Fragment key={child.id}>
            {child.type === 'condition' ? (
              <ConditionRow
                condition={child}
                onChange={(updated) => handleChildChange(index, updated)}
                onRemove={() => handleRemoveChild(index)}
                showRemove={group.children.length > 1}
              />
            ) : (
              <ConditionGroup
                group={child}
                onChange={(updated) => handleChildChange(index, updated)}
                onRemove={() => handleRemoveChild(index)}
                depth={depth + 1}
                showRemove={true}
              />
            )}
          </React.Fragment>
        ))}

        {/* Add buttons */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={handleAddCondition}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-1" />
            Add condition
          </Button>
          {depth < 2 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleAddGroup}
            >
              <PlusIcon className="h-3.5 w-3.5 mr-1" />
              Add {group.operator === 'and' ? 'OR' : 'AND'} group
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Main condition builder component
export function ConditionBuilder({
  value,
  onChange,
}: {
  value: RuleNode,
  onChange: (value: RuleNode) => void,
}) {
  // Ensure we have a group at the root
  const rootGroup: GroupNode = value.type === 'group'
    ? value
    : {
      type: 'group',
      id: 'root',
      operator: 'and',
      children: [value],
    };

  const normalizedGroup = rootGroup.children.length > 0
    ? rootGroup
    : { ...rootGroup, children: [createEmptyCondition()] };

  return (
    <div className="space-y-3">
      <ConditionGroup
        group={normalizedGroup}
        onChange={(updated) => onChange(updated)}
        depth={0}
      />
    </div>
  );
}
