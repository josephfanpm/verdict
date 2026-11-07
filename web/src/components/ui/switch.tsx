import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[26px] w-[44px] shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-colors data-[state=checked]:bg-good data-[state=unchecked]:bg-border-strong',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[22px] rounded-full bg-white shadow-[0_2px_4px_rgb(0_0_0/0.2)] transition-transform duration-200 data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}
