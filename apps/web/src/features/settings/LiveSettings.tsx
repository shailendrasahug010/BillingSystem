import { BusinessProfileCard } from "./BusinessProfileCard";
import { RulesCard } from "./RulesCard";
import { WarehousesCard } from "./WarehousesCard";
import { PriceListsCard } from "./PriceListsCard";
import { SeriesCard } from "./SeriesCard";
import { MessagingCard } from "./MessagingCard";
import { DevicesCard } from "./DevicesCard";
import { PrinterCard } from "./PrinterCard";
import { PayrollStatutoryCard } from "./PayrollStatutoryCard";
import { TallyCard } from "./TallyCard";
import { PhoneAccessCard } from "./PhoneAccessCard";
import { SignInSecurityCard } from "./SignInSecurityCard";

/**
 * Settings in the live app: one card per concern, each in its own file.
 */
export function LiveSettings() {
  return (
    <>
      <BusinessProfileCard />
      <PhoneAccessCard />
      <RulesCard />
      <PayrollStatutoryCard />
      <WarehousesCard />
      <PriceListsCard />
      <SeriesCard />
      <MessagingCard />
      <DevicesCard />
      <SignInSecurityCard />
      <TallyCard />
      <PrinterCard />
    </>
  );
}
