import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-xs font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 active:translate-y-[1px] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none',
  {
    variants: {
      variant: {
        default:
          'bg-gradient-to-b from-sky-500 to-sky-600 text-white border border-sky-600 shadow-xs hover:from-sky-600 hover:to-sky-700',
        amber:
          'bg-gradient-to-b from-amber-500 to-amber-600 text-white border border-amber-600 shadow-xs hover:from-amber-600 hover:to-amber-700',
        success:
          'bg-gradient-to-b from-emerald-500 to-emerald-600 text-white border border-emerald-600 shadow-xs hover:from-emerald-600 hover:to-emerald-700',
        destructive:
          'bg-gradient-to-b from-red-500 to-red-600 text-white border border-red-700 shadow-xs hover:from-red-600 hover:to-red-700 font-bold tracking-wide',
        outline:
          'border border-slate-200 bg-white text-slate-700 shadow-2xs hover:bg-sky-50/70 hover:text-sky-700 hover:border-sky-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
        outlineAmber:
          'border border-amber-300 bg-amber-50/50 text-amber-800 hover:bg-amber-100/70 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300',
        secondary:
          'bg-slate-100 text-slate-800 border border-slate-200 hover:bg-slate-200/70 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700',
        ghost:
          'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white',
      },
      size: {
        default: 'h-9 px-3.5 py-2',
        sm: 'h-7 rounded-md px-2.5 text-[11px]',
        lg: 'h-10 rounded-lg px-4 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
