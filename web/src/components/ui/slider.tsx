import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Slider({ className, label, ...props }: ComponentProps<typeof SliderPrimitive.Root> & { label: string }) {
  return (
    <SliderPrimitive.Root className={cn('relative flex h-6 w-full touch-none select-none items-center', className)} {...props}>
      <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-border">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        className="block size-5 cursor-grab rounded-full border border-border-strong bg-white shadow-[0_2px_6px_rgb(0_0_0/0.18)] outline-none transition-transform hover:scale-110 focus-visible:ring-4 focus-visible:ring-ring active:cursor-grabbing"
      />
    </SliderPrimitive.Root>
  );
}
