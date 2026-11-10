import { type FilterOption, parseTimeRange, TIME_RANGE_OPTIONS, type TimeRange } from "../lib/filter-options";
import { FilterField, MultiSelect, Select } from "./design";

/** The one single-choice filter: ranges nest, so selecting several would be meaningless. */
export function TimeRangeFilter({ value, onChange }: { value: TimeRange, onChange: (range: TimeRange) => void }) {
  return (
    <FilterField label="Range" controlClassName="w-32">
      <Select value={value} onChange={event => onChange(parseTimeRange(event.target.value))}>
        {TIME_RANGE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    </FilterField>
  );
}

/**
 * Labelled multi-select used for every categorical filter. `controlClassName` sets the trigger
 * width (static Tailwind class, eg. "w-44"); an empty selection means no filter.
 */
export function MultiFilter<Value extends string>({ label, options, selected, onChange, mono = false, controlClassName = "w-36" }: {
  label: string,
  options: ReadonlyArray<FilterOption<Value>>,
  selected: ReadonlySet<Value>,
  onChange: (selected: Set<Value>) => void,
  mono?: boolean,
  controlClassName?: string,
}) {
  return (
    <FilterField label={label} controlClassName={controlClassName}>
      <MultiSelect
        label={label}
        options={options.map(option => ({ ...option, mono }))}
        selected={selected}
        onChange={onChange}
      />
    </FilterField>
  );
}
