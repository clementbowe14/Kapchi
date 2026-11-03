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
  export const AlertCircle: LucideIcon;
  export const AlertTriangle: LucideIcon;
  export const ArrowLeft: LucideIcon;
  export const CirclePause: LucideIcon;
  export const CirclePlay: LucideIcon;
  export const Filter: LucideIcon;
  export const Download: LucideIcon;
  export const ExternalLink: LucideIcon;
  export const ImageIcon: LucideIcon;
  export const LoaderCircle: LucideIcon;
  export const Mail: LucideIcon;
  export const Minus: LucideIcon;
  export const Phone: LucideIcon;
  export const PackageCheck: LucideIcon;
  export const PackageOpen: LucideIcon;
  export const Pencil: LucideIcon;
  export const Plus: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const RotateCcw: LucideIcon;
  export const ShieldAlert: LucideIcon;
  export const ShoppingCart: LucideIcon;
  export const Trash2: LucideIcon;
  export const Truck: LucideIcon;
  export const Type: LucideIcon;
  export const UserRound: LucideIcon;
  export const WandSparkles: LucideIcon;
}
