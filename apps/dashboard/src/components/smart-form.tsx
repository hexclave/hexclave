"use client";

import { yupResolver } from "@hookform/resolvers/yup";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Form } from "@/components/ui";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import * as yup from "yup";
import { CheckboxField, DateField, InputField, NumberField, TextAreaField } from "./form-fields";

// Used for yup TS support
declare module 'yup' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  export interface CustomSchemaMetadata {
    stackFormFieldRender?: (props: { control: ReturnType<typeof useForm>['control'], name: string, label: string, disabled: boolean }) => React.ReactNode,
    stackFormFieldPlaceholder?: string,
    stackFormFieldExtraProps?: Record<string, string | number | boolean | undefined>,
    type?: "text" | "textarea",
    description?: string,
  }
}

export function SmartForm<S extends yup.ObjectSchema<any>>(props: {
  formSchema: S,
  onSubmit: (values: yup.InferType<S>) => Promise<void>,
  formId?: string,
  onChangeIsSubmitting?: (isSubmitting: boolean) => void,
  defaultValues?: Partial<yup.InferType<S>>,
  isOpen?: boolean,
}) {
  const resolvedDefaultValues = props.defaultValues ?? props.formSchema.getDefault();
  const form = useForm({
    resolver: yupResolver(props.formSchema),
    defaultValues: resolvedDefaultValues,
    mode: "onChange",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const handleSubmit = useCallback(async (e: React.BaseSyntheticEvent) => {
    props.onChangeIsSubmitting?.(true);
    setIsSubmitting(true);
    try {
      await form.handleSubmit(async (values: yup.InferType<S>, e?: React.BaseSyntheticEvent) => {
        e!.preventDefault();
        await props.onSubmit(values);
        form.reset(resolvedDefaultValues);
      })(e);
    } finally {
      props.onChangeIsSubmitting?.(false);
      setIsSubmitting(false);
    }
  }, [props, form, resolvedDefaultValues]);

  const prevOpen = useRef(props.isOpen ?? false);
  useEffect(() => {
    const currentOpen = props.isOpen ?? false;
    if (currentOpen && !prevOpen.current) {
      form.reset(resolvedDefaultValues);
    }
    prevOpen.current = currentOpen;
  }, [props.isOpen, resolvedDefaultValues, form]);

  const details = props.formSchema.describe();
  const defaults = resolvedDefaultValues;

  return (
    <Form {...form}>
      <form onSubmit={(e) => runAsynchronously(handleSubmit(e))} id={props.formId} className="space-y-4">
        {Object.entries(details.fields).map(([fieldId, field]) => (
          <SmartFormField key={fieldId} id={fieldId} description={field} form={form} disabled={isSubmitting} defaultValue={defaults[fieldId]} />
        ))}
      </form>
    </Form>
  );
};
SmartForm.displayName = 'SmartForm';

function SmartFormField(props: {
  id: string,
  description: yup.SchemaFieldDescription,
  form: ReturnType<typeof useForm>,
  disabled: boolean,
  defaultValue: unknown,
}) {
  const usualProps = {
    control: props.form.control,
    name: props.id,
    label: ("label" in props.description ? props.description.label : null) ?? props.id,
    disabled: props.disabled,
    required: !("optional" in props.description && props.description.optional),
    placeholder: "meta" in props.description && props.description.meta?.stackFormFieldPlaceholder !== undefined ? props.description.meta.stackFormFieldPlaceholder :
      typeof props.defaultValue === "string" ? `Eg.: ${props.defaultValue}` : undefined,
    defaultValue: props.defaultValue,
    description: "meta" in props.description ? props.description.meta?.description : undefined,
    ..."meta" in props.description ? props.description.meta?.stackFormFieldExtraProps : undefined,
  };

  if ("meta" in props.description) {
    const meta = props.description.meta;
    const stackFormFieldRender = meta?.stackFormFieldRender;
    if (stackFormFieldRender) {
      return stackFormFieldRender(usualProps);
    }
  }

  if (props.description.type === 'ref') {
    // don't render refs
    return null;
  }
  if (!("oneOf" in props.description)) {
    throw new HexclaveAssertionError(`Unsupported yup field ${props.id}; can't create form automatically from lazy yup schema`);
  }

  switch (props.description.type) {
    case 'string': {
      if (props.description.meta?.type === "textarea") {
        return <TextAreaField {...usualProps} />;
      } else {
        return <InputField {...usualProps} />;
      }
    }
    case 'date': {
      return <DateField {...usualProps} />;
    }
    case 'boolean': {
      return <CheckboxField {...usualProps} />;
    }
    case 'number': {
      return <NumberField {...usualProps} />;
    }
  }

  throw new HexclaveAssertionError(`Unsupported yup field ${props.id}; can't create form automatically from schema of type ${JSON.stringify(props.description.type)}. Maybe you need to implement it, or add a stackFormFieldRender meta property to the schema.`);
}
