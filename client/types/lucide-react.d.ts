declare module "lucide-react" {
  import type {
    ForwardRefExoticComponent,
    RefAttributes,
    SVGProps,
  } from "react";

  export type LucideProps = SVGProps<SVGSVGElement> & {
    absoluteStrokeWidth?: boolean;
    size?: number | string;
    strokeWidth?: number | string;
  };

  export type LucideIcon = ForwardRefExoticComponent<
    Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
  >;

  export const ChevronLeft: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const CirclePause: LucideIcon;
  export const CirclePlay: LucideIcon;
  export const ImageIcon: LucideIcon;
  export const Minus: LucideIcon;
  export const Plus: LucideIcon;
  export const ShoppingCart: LucideIcon;
  export const Trash2: LucideIcon;
  export const Type: LucideIcon;
  export const WandSparkles: LucideIcon;
}
