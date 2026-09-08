export type PaymentStatus= "PENDING" | "SUCCESS" | "FAILED";

export interface Payemnt{
    id:string,
    amount:number,
    currency:string,
    status:PaymentStatus
}